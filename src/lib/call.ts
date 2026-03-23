import Peer, { type MediaConnection } from 'peerjs';
import { computeVerificationCode, arrayBufferToBase64, base64ToArrayBuffer } from './crypto';

const supportsE2EE =
  typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;

type AppState = 'idle' | 'requesting-media' | 'connecting' | 'waiting' | 'connected' | 'disconnected';

function setState(state: AppState) {
  const app = document.getElementById('app');
  if (app) app.dataset.state = state;

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  const messages: Record<string, string> = {
    'requesting-media': 'Requesting microphone...',
    connecting: 'Connecting...',
    waiting: 'Waiting for someone to join...',
    connected: 'Connected',
    disconnected: 'Disconnected',
  };

  if (statusDot) {
    statusDot.className = 'status-dot ' + (state === 'requesting-media' || state === 'connecting' ? 'waiting' : state);
  }
  if (statusText && messages[state]) {
    statusText.textContent = messages[state];
  }

  if (state === 'disconnected') {
    document.getElementById('share-section')?.classList.add('hidden');
    document.getElementById('controls')?.classList.add('hidden');
    document.getElementById('ended-section')?.classList.remove('hidden');
    document.getElementById('video-section')?.classList.add('hidden');
  }
}

function showVerificationCode(code: string) {
  const el = document.getElementById('verification-code');
  if (el) {
    el.textContent = code;
    el.classList.remove('hidden');
  }
}

function showE2eeBadge(active: boolean) {
  const badge = document.getElementById('e2ee-badge');
  const status = document.getElementById('e2ee-status');
  if (badge) {
    badge.classList.remove('hidden');
    if (status) status.textContent = active ? 'E2EE' : 'E2EE unavailable';
    if (!active) badge.style.opacity = '0.5';
  }
}

// Audio analyser for orb reactivity
let animationFrameId: number | null = null;

function startOrbReactivity(remoteStream: MediaStream) {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(remoteStream);
  source.connect(analyser);
  analyser.fftSize = 256;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const orbButton = document.getElementById('orb-button');

  function update() {
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const scale = 1 + (avg / 255) * 0.35;
    if (orbButton) {
      orbButton.style.transform = `scale(${scale})`;
    }
    animationFrameId = requestAnimationFrame(update);
  }
  update();

  return () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    audioContext.close();
    if (orbButton) orbButton.style.transform = '';
  };
}

// E2EE transforms
function applyE2eeTransforms(pc: RTCPeerConnection, keyRaw: ArrayBuffer) {
  if (!supportsE2EE) return;

  for (const sender of pc.getSenders()) {
    if (sender.track) {
      const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'setKey', key: keyRaw });
      (sender as any).transform = new (window as any).RTCRtpScriptTransform(worker, {
        direction: 'encrypt',
        kind: sender.track.kind,
      });
    }
  }

  for (const receiver of pc.getReceivers()) {
    if (receiver.track) {
      const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'setKey', key: keyRaw });
      (receiver as any).transform = new (window as any).RTCRtpScriptTransform(worker, {
        direction: 'decrypt',
        kind: receiver.track.kind,
      });
    }
  }

  showE2eeBadge(true);
}

export async function initCall(roomId: string): Promise<void> {
  let peer: Peer | null = null;
  let activeCall: MediaConnection | null = null;
  let localStream: MediaStream | null = null;
  let stopOrbReactivity: (() => void) | null = null;
  let videoEnabled = false;
  let e2eeKeyRaw: ArrayBuffer | null = null;

  // 1. Get audio
  setState('requesting-media');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch {
    setState('disconnected');
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = 'Microphone access denied.';
    return;
  }

  setState('connecting');

  // 2. Fetch HMAC TURN credentials (time-limited, per-session)
  let iceServers: RTCIceServer[] = [];

  try {
    const res = await fetch('/api/turn-credentials');
    if (res.ok) {
      const data = await res.json();
      iceServers = data.iceServers;
      console.log('[call] TURN credentials fetched, TTL:', data.ttl);
    }
  } catch {
    console.warn('[call] Could not fetch TURN credentials');
  }

  if (iceServers.length === 0) {
    setState('disconnected');
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = 'Failed to connect to relay server.';
    return;
  }

  // 3. PeerServer config
  const peerConfig = {
    host: location.hostname,
    port: location.port ? parseInt(location.port) : (location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    secure: location.protocol === 'https:',
    debug: 1,
    config: {
      iceServers,
      iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
    },
  };

  // 3. Try to register as the room (creator)
  //    If the ID is taken, we're the joiner
  peer = new Peer(roomId, peerConfig);

  peer.on('open', (id) => {
    console.log('[call] registered as room:', id);
    setState('waiting');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      // Room exists — we're the joiner
      console.log('[call] room exists, joining as caller');
      peer?.destroy();
      joinAsGuest();
    } else if (err.type === 'peer-unavailable') {
      console.error('[call] peer not found');
    } else {
      console.error('[call] error:', err.type, err.message);
    }
  });

  // 4. Handle incoming call (we're the creator)
  peer.on('call', (call) => {
    console.log('[call] incoming call from:', call.peer);
    call.answer(localStream!);
    handleCall(call, true);
  });

  peer.on('disconnected', () => {
    console.log('[call] disconnected from PeerServer');
  });

  // 5. Join as guest — create anonymous peer, call the room ID
  function joinAsGuest() {
    peer = new Peer(peerConfig);

    peer.on('open', (myId) => {
      console.log('[call] joined as:', myId, '→ calling room:', roomId);
      const call = peer!.call(roomId, localStream!);
      if (call) {
        handleCall(call, false);
      } else {
        console.error('[call] failed to create call');
        setState('disconnected');
      }
    });

    peer.on('error', (err) => {
      console.error('[call] guest error:', err.type, err.message);
      if (err.type === 'peer-unavailable') {
        const statusText = document.getElementById('status-text');
        if (statusText) statusText.textContent = 'Room not found. The host may have left.';
        setState('disconnected');
      }
    });
  }

  // 6. Handle active call (both creator and joiner)
  function handleCall(call: MediaConnection, isCreator: boolean) {
    activeCall = call;
    setState('connected');
    document.getElementById('share-section')?.classList.add('hidden');

    call.on('stream', (remoteStream) => {
      console.log('[call] received remote stream');

      // Play remote audio
      const remoteAudio = document.getElementById('remote-audio') as HTMLAudioElement;
      if (remoteAudio) remoteAudio.srcObject = remoteStream;

      // Orb audio reactivity
      if (!stopOrbReactivity) {
        stopOrbReactivity = startOrbReactivity(remoteStream);
      }

      // If remote has video, show it
      if (remoteStream.getVideoTracks().length > 0) {
        const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement;
        if (remoteVideo) remoteVideo.srcObject = remoteStream;
        document.getElementById('video-section')?.classList.remove('hidden');
      }

      // Verification code from DTLS fingerprints
      const pc = call.peerConnection;
      if (pc) {
        const localSdp = pc.localDescription?.sdp || '';
        const remoteSdp = pc.remoteDescription?.sdp || '';
        computeVerificationCode(localSdp, remoteSdp).then(showVerificationCode);

        // E2EE — creator generates key, sends via data connection
        if (isCreator && supportsE2EE) {
          setupE2eeAsCreator(pc);
        }
        if (!supportsE2EE) showE2eeBadge(false);
      }
    });

    call.on('close', () => {
      console.log('[call] call closed');
      cleanup();
      setState('disconnected');
    });

    call.on('error', (err) => {
      console.error('[call] call error:', err);
      cleanup();
      setState('disconnected');
    });

    // Listen for E2EE key via data connection (joiner side)
    if (!isCreator) {
      peer?.on('connection', (conn) => {
        conn.on('data', (data: any) => {
          if (data?.type === 'e2ee-key') {
            e2eeKeyRaw = base64ToArrayBuffer(data.key);
            const pc = activeCall?.peerConnection;
            if (pc && e2eeKeyRaw) applyE2eeTransforms(pc, e2eeKeyRaw);
          }
        });
      });
    }
  }

  // E2EE key generation and exchange
  async function setupE2eeAsCreator(pc: RTCPeerConnection) {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    e2eeKeyRaw = await crypto.subtle.exportKey('raw', key);
    applyE2eeTransforms(pc, e2eeKeyRaw);

    // Send key to joiner via data connection
    if (activeCall && peer) {
      const conn = peer.connect(activeCall.peer);
      conn.on('open', () => {
        conn.send({ type: 'e2ee-key', key: arrayBufferToBase64(e2eeKeyRaw!) });
      });
    }
  }

  function cleanup() {
    activeCall?.close();
    activeCall = null;
    stopOrbReactivity?.();
    stopOrbReactivity = null;
    e2eeKeyRaw = null;

    const remoteAudio = document.getElementById('remote-audio') as HTMLAudioElement;
    if (remoteAudio) remoteAudio.srcObject = null;
    const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement;
    if (remoteVideo) remoteVideo.srcObject = null;
    document.getElementById('video-section')?.classList.add('hidden');
    document.getElementById('verification-code')?.classList.add('hidden');
    document.getElementById('e2ee-badge')?.classList.add('hidden');
  }

  // 7. UI controls
  document.getElementById('toggle-mic')?.addEventListener('click', () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      document.getElementById('toggle-mic')?.classList.toggle('control-off', !audioTrack.enabled);
      document.getElementById('mic-on')?.classList.toggle('hidden', !audioTrack.enabled);
      document.getElementById('mic-off')?.classList.toggle('hidden', audioTrack.enabled);
    }
  });

  document.getElementById('toggle-video')?.addEventListener('click', async () => {
    if (!videoEnabled) {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        const videoTrack = videoStream.getVideoTracks()[0];
        localStream?.addTrack(videoTrack);

        // Add track to peer connection
        const pc = activeCall?.peerConnection;
        if (pc) pc.addTrack(videoTrack, localStream!);

        const localVideo = document.getElementById('local-video') as HTMLVideoElement;
        if (localVideo) localVideo.srcObject = new MediaStream([videoTrack]);
        document.getElementById('video-section')?.classList.remove('hidden');

        videoEnabled = true;
        document.getElementById('toggle-video')?.classList.remove('control-off');
        document.getElementById('vid-on')?.classList.remove('hidden');
        document.getElementById('vid-off')?.classList.add('hidden');
      } catch {
        // Camera denied
      }
    } else {
      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        localStream?.removeTrack(videoTrack);
        const pc = activeCall?.peerConnection;
        const sender = pc?.getSenders().find((s) => s.track === videoTrack);
        if (sender) pc?.removeTrack(sender);
      }
      videoEnabled = false;
      document.getElementById('toggle-video')?.classList.add('control-off');
      document.getElementById('vid-on')?.classList.add('hidden');
      document.getElementById('vid-off')?.classList.remove('hidden');

      const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement;
      if (!remoteVideo?.srcObject || !(remoteVideo.srcObject as MediaStream).getVideoTracks().length) {
        document.getElementById('video-section')?.classList.add('hidden');
      }
    }
  });

  document.getElementById('copy-link')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
  });

  document.getElementById('copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    document.getElementById('copy-icon')?.classList.add('hidden');
    document.getElementById('copied-icon')?.classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('copy-icon')?.classList.remove('hidden');
      document.getElementById('copied-icon')?.classList.add('hidden');
    }, 2000);
  });

  document.getElementById('hang-up')?.addEventListener('click', () => {
    cleanup();
    localStream?.getTracks().forEach((t) => t.stop());
    peer?.destroy();
    peer = null;
    setState('disconnected');
  });
}
