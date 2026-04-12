import {
  deriveAdmissionProof,
  deriveSignalingKey,
  deriveCallKey,
  encryptSignaling,
  decryptSignaling,
  computeVerificationCode,
} from './crypto';

type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

type ServerFrame =
  | { source: 'server'; type: 'peer-joined' | 'peer-left' }
  | { source: 'server'; type: 'signal'; payload: string };

function isSignalingMessage(msg: unknown): msg is SignalingMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const { type } = msg as { type?: unknown };
  return type === 'offer' || type === 'answer' || type === 'candidate';
}

function isServerFrame(msg: unknown): msg is ServerFrame {
  if (typeof msg !== 'object' || msg === null) return false;

  const { source, type, payload } = msg as {
    source?: unknown;
    type?: unknown;
    payload?: unknown;
  };

  if (source !== 'server') return false;
  if (type === 'peer-joined' || type === 'peer-left') return true;
  return type === 'signal' && typeof payload === 'string';
}

const supportsE2EE =
  typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;
let activeSessionTeardown: ((silent?: boolean) => void) | null = null;

type AppState = 'idle' | 'requesting-media' | 'connecting' | 'waiting' | 'connected' | 'disconnected';

// --- UI helpers ---

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

  if (statusDot) statusDot.className = 'status-dot ' + (state === 'requesting-media' || state === 'connecting' ? 'waiting' : state);
  if (statusText && messages[state]) statusText.textContent = messages[state];

  if (state === 'disconnected') {
    document.getElementById('share-section')?.classList.add('hidden');
    document.getElementById('controls')?.classList.add('hidden');
    document.getElementById('ended-section')?.classList.remove('hidden');
    document.getElementById('video-section')?.classList.add('hidden');
  }
}

function setStatusText(message: string) {
  const statusText = document.getElementById('status-text');
  if (statusText) statusText.textContent = message;
}

function setMicToggleState(enabled: boolean) {
  document.getElementById('toggle-mic')?.classList.toggle('control-off', !enabled);
  document.getElementById('mic-on')?.classList.toggle('hidden', !enabled);
  document.getElementById('mic-off')?.classList.toggle('hidden', enabled);
}

function setVideoToggleState(enabled: boolean) {
  document.getElementById('toggle-video')?.classList.toggle('control-off', !enabled);
  document.getElementById('vid-on')?.classList.toggle('hidden', !enabled);
  document.getElementById('vid-off')?.classList.toggle('hidden', enabled);
}

function showVerificationCode(code: string) {
  const el = document.getElementById('verification-code');
  if (el) { el.textContent = code; el.classList.remove('hidden'); }
}

function showE2eeBadge(active: boolean) {
  const badge = document.getElementById('e2ee-badge');
  const status = document.getElementById('e2ee-status');
  if (badge) {
    badge.classList.remove('hidden');
    if (status) status.textContent = active ? 'E2EE' : 'E2EE unavailable';
    badge.style.opacity = active ? '1' : '0.5';
  }
}

// --- Audio analyser for orb ---

let animFrameId: number | null = null;

function startOrbReactivity(stream: MediaStream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);
  const orb = document.getElementById('orb-button');

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    if (orb) orb.style.transform = `scale(${1 + (avg / 255) * 0.35})`;
    animFrameId = requestAnimationFrame(tick);
  }
  tick();

  return () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    ctx.close();
    if (orb) orb.style.transform = '';
  };
}

// --- E2EE transforms ---

function applyE2ee(pc: RTCPeerConnection, keyRaw: ArrayBuffer) {
  if (!supportsE2EE) return;

  const apply = (transceiver: RTCRtpSender | RTCRtpReceiver, direction: 'encrypt' | 'decrypt') => {
    if (!transceiver.track) return;
    const w = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ type: 'setKey', key: keyRaw });
    transceiver.transform = new RTCRtpScriptTransform(w, { direction, kind: transceiver.track.kind });
  };

  pc.getSenders().forEach((s) => apply(s, 'encrypt'));
  pc.getReceivers().forEach((r) => apply(r, 'decrypt'));
  showE2eeBadge(true);
}

// --- Main ---

export async function initCall(
  roomId: string,
  shareSecret: string,
  pin?: string,
): Promise<void> {
  activeSessionTeardown?.(true);

  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let localStream: MediaStream | null = null;
  let stopOrb: (() => void) | null = null;
  let remoteStream: MediaStream | null = null;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let videoEnabled = false;
  let sessionEnded = false;
  let callKeyRaw: ArrayBuffer | null = null;

  function updateVideoSectionVisibility() {
    const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().length);
    document.getElementById('video-section')?.classList.toggle('hidden', !videoEnabled && !hasRemoteVideo);
  }

  function clearRemoteMedia() {
    remoteStream = null;
    const audio = document.getElementById('remote-audio') as HTMLAudioElement | null;
    if (audio) audio.srcObject = null;
    const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
    if (remoteVideo) remoteVideo.srcObject = null;
    document.getElementById('verification-code')?.classList.add('hidden');
    document.getElementById('e2ee-badge')?.classList.add('hidden');
    updateVideoSectionVisibility();
  }

  function stopLocalMedia() {
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    const localVideo = document.getElementById('local-video') as HTMLVideoElement | null;
    if (localVideo) localVideo.srcObject = null;
    videoEnabled = false;
    setMicToggleState(true);
    setVideoToggleState(false);
    updateVideoSectionVisibility();
  }

  function cleanupPeerConnection() {
    const currentPc = pc;
    pc = null;

    if (currentPc) {
      currentPc.onicecandidate = null;
      currentPc.ontrack = null;
      currentPc.onconnectionstatechange = null;
      currentPc.onnegotiationneeded = null;
      currentPc.close();
    }

    pendingCandidates = [];
    stopOrb?.();
    stopOrb = null;
    clearRemoteMedia();
  }

  function closeSocket() {
    const currentWs = ws;
    ws = null;

    if (!currentWs) return;

    currentWs.onopen = null;
    currentWs.onerror = null;
    currentWs.onmessage = null;
    currentWs.onclose = null;

    if (
      currentWs.readyState === WebSocket.CONNECTING ||
      currentWs.readyState === WebSocket.OPEN
    ) {
      currentWs.close();
    }
  }

  const teardownSession = (silent = false) => {
    if (sessionEnded) return;

    sessionEnded = true;
    cleanupPeerConnection();
    stopLocalMedia();
    closeSocket();

    if (activeSessionTeardown === teardownSession) {
      activeSessionTeardown = null;
    }

    if (!silent) {
      setState('disconnected');
      setStatusText('Disconnected');
    }
  };

  function endSession(message: string) {
    teardownSession(true);
    setState('disconnected');
    setStatusText(message);
  }

  function describeSocketClose(event: CloseEvent): string {
    switch (event.code) {
      case 4001:
        return 'This room already has two participants.';
      case 4002:
      case 4003:
        return 'This call link or PIN did not match.';
      default:
        return 'Connection failed.';
    }
  }

  activeSessionTeardown = teardownSession;

  const toggleMicButton = document.getElementById('toggle-mic') as HTMLButtonElement | null;
  if (toggleMicButton) {
    toggleMicButton.onclick = () => {
      const track = localStream?.getAudioTracks()[0];
      if (!track) return;

      track.enabled = !track.enabled;
      setMicToggleState(track.enabled);
    };
  }

  const toggleVideoButton = document.getElementById('toggle-video') as HTMLButtonElement | null;
  if (toggleVideoButton) {
    toggleVideoButton.onclick = async () => {
      if (sessionEnded) return;

      if (!videoEnabled) {
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          });
          const videoTrack = videoStream.getVideoTracks()[0];
          if (!videoTrack || !localStream) {
            videoStream.getTracks().forEach((track) => track.stop());
            return;
          }

          if (sessionEnded) {
            videoStream.getTracks().forEach((track) => track.stop());
            return;
          }

          localStream.addTrack(videoTrack);
          pc?.addTrack(videoTrack, localStream);

          if (supportsE2EE && pc && callKeyRaw) {
            const sender = pc.getSenders().find((candidate) => candidate.track === videoTrack);
            if (sender?.track) {
              const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
              worker.postMessage({ type: 'setKey', key: callKeyRaw });
              sender.transform = new RTCRtpScriptTransform(worker, { direction: 'encrypt', kind: 'video' });
            }
          }

          const localVideo = document.getElementById('local-video') as HTMLVideoElement | null;
          if (localVideo) {
            localVideo.srcObject = new MediaStream([videoTrack]);
            localVideo.play().catch(() => {});
          }

          videoEnabled = true;
          setVideoToggleState(true);
          updateVideoSectionVisibility();
        } catch {
          return;
        }

        return;
      }

      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        localStream?.removeTrack(videoTrack);
        const sender = pc?.getSenders().find((candidate) => candidate.track === videoTrack);
        if (sender) pc?.removeTrack(sender);
      }

      const localVideo = document.getElementById('local-video') as HTMLVideoElement | null;
      if (localVideo) localVideo.srcObject = null;

      videoEnabled = false;
      setVideoToggleState(false);
      updateVideoSectionVisibility();
    };
  }

  const copyLinkButton = document.getElementById('copy-link') as HTMLButtonElement | null;
  if (copyLinkButton) {
    copyLinkButton.onclick = () => {
      navigator.clipboard.writeText(window.location.href);
    };
  }

  const copyInviteButton = document.getElementById('copy-btn') as HTMLButtonElement | null;
  if (copyInviteButton) {
    copyInviteButton.onclick = () => {
      navigator.clipboard.writeText(window.location.href);
      document.getElementById('copy-icon')?.classList.add('hidden');
      document.getElementById('copied-icon')?.classList.remove('hidden');
      setTimeout(() => {
        document.getElementById('copy-icon')?.classList.remove('hidden');
        document.getElementById('copied-icon')?.classList.add('hidden');
      }, 2000);
    };
  }

  const hangUpButton = document.getElementById('hang-up') as HTMLButtonElement | null;
  if (hangUpButton) {
    hangUpButton.onclick = () => {
      endSession('Disconnected');
    };
  }

  setMicToggleState(true);
  setVideoToggleState(false);

  // 1. Get audio
  setState('requesting-media');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,        // mono — halves processing load, better for voice
        sampleRate: 48000,      // Opus native rate
        sampleSize: 16,
      },
      video: false,
    });
  } catch {
    if (!sessionEnded) {
      setState('disconnected');
      setStatusText('Microphone access denied.');
    }
    if (activeSessionTeardown === teardownSession) {
      activeSessionTeardown = null;
    }
    return;
  }

  if (sessionEnded) {
    stopLocalMedia();
    return;
  }

  // 2. Fetch TURN credentials
  setState('connecting');
  let iceServers: RTCIceServer[] = [];
  try {
    const res = await fetch('/api/turn-credentials');
    if (res.ok) {
      const data = await res.json() as { iceServers: RTCIceServer[] };
      iceServers = data.iceServers;
    }
  } catch { /* */ }

  if (!iceServers.length) {
    endSession('Failed to connect to relay server.');
    return;
  }

  // 3. Derive keys from the public room ID plus the secret share link fragment.
  let joinProof: string;
  let sigKey: CryptoKey;
  try {
    joinProof = await deriveAdmissionProof(roomId, shareSecret, pin);
    sigKey = await deriveSignalingKey(roomId, shareSecret, pin);
    const callKey = await deriveCallKey(roomId, shareSecret, pin);
    callKeyRaw = await crypto.subtle.exportKey('raw', callKey);
  } catch {
    endSession('Failed to initialize call encryption.');
    return;
  }

  if (!callKeyRaw) {
    endSession('Failed to initialize call encryption.');
    return;
  }

  if (sessionEnded) return;

  // 4. Encrypted signaling helpers
  async function send(data: object) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(await encryptSignaling(sigKey, data));
    }
  }

  // 5. WebRTC peer connection
  function createPC() {
    if (pc) return pc;

    pendingCandidates = [];

    const nextPc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });
    pc = nextPc;

    localStream?.getTracks().forEach((track) => nextPc.addTrack(track, localStream!));

    nextPc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'candidate', candidate: e.candidate.toJSON() });
    };

    nextPc.ontrack = (e) => {
      // Some browsers don't associate tracks with streams — build our own
      if (e.streams[0]) {
        remoteStream = e.streams[0];
      } else {
        if (!remoteStream) remoteStream = new MediaStream();
        if (!remoteStream.getTracks().includes(e.track)) remoteStream.addTrack(e.track);
      }

      const audio = document.getElementById('remote-audio') as HTMLAudioElement;
      if (audio) {
        audio.srcObject = remoteStream;
        audio.play().catch(() => {});
      }

      // Start orb reactivity if connection is already confirmed (race-free)
      if (!stopOrb && pc?.connectionState === 'connected') {
        stopOrb = startOrbReactivity(remoteStream);
      }

      if (e.track.kind === 'video') {
        const vid = document.getElementById('remote-video') as HTMLVideoElement;
        if (vid) {
          vid.srcObject = remoteStream;
          vid.play().catch(() => {});
        }
        updateVideoSectionVisibility();

        // Apply E2EE to new video receiver (for renegotiation after initial connection)
        if (supportsE2EE && nextPc.connectionState === 'connected') {
          const receiver = nextPc.getReceivers().find((r) => r.track === e.track);
          if (receiver?.track) {
            const w = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
            w.postMessage({ type: 'setKey', key: callKeyRaw });
            receiver.transform = new RTCRtpScriptTransform(w, { direction: 'decrypt', kind: 'video' });
          }
        }
      }
    };

    nextPc.onconnectionstatechange = () => {
      if (nextPc.connectionState === 'connected') {
        setState('connected');
        document.getElementById('share-section')?.classList.add('hidden');

        if (!stopOrb && remoteStream) stopOrb = startOrbReactivity(remoteStream);

        // Safety numbers
        const local = nextPc.localDescription?.sdp || '';
        const remote = nextPc.remoteDescription?.sdp || '';
        computeVerificationCode(local, remote).then(showVerificationCode);

        // Apply E2EE
        if (supportsE2EE) applyE2ee(nextPc, callKeyRaw);
        else showE2eeBadge(false);
      }

      if (nextPc.connectionState === 'failed' || nextPc.connectionState === 'disconnected') {
        endSession('Connection lost.');
      }
    };

    nextPc.onnegotiationneeded = async () => {
      if (nextPc.connectionState !== 'connected') return;
      if (nextPc.signalingState !== 'stable') return;
      try {
        const offer = await nextPc.createOffer();
        if (nextPc.signalingState !== 'stable') return;
        await nextPc.setLocalDescription(offer);
        send({ type: 'offer', sdp: offer.sdp });
      } catch { /* ignore */ }
    };

    return nextPc;
  }

  // 6. Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const joinUrl = new URL(`${proto}//${location.host}/ws`);
  joinUrl.searchParams.set('room', roomId);
  joinUrl.searchParams.set('proof', joinProof);
  ws = new WebSocket(joinUrl);
  let socketErrored = false;

  ws.onopen = () => {
    if (!sessionEnded) setState('waiting');
  };

  ws.onerror = () => {
    socketErrored = true;
  };

  ws.onmessage = async (event) => {
    if (sessionEnded) return;

    let frame: unknown;
    try {
      frame = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (!isServerFrame(frame)) return;

    if (frame.type === 'peer-joined') {
      // We were here first — create offer
      const connection = createPC();
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      send({ type: 'offer', sdp: offer.sdp });
      return;
    }

    if (frame.type === 'peer-left') {
      endSession('The other person left the call.');
      return;
    }

    try {
      const msg = await decryptSignaling(sigKey, frame.payload);
      if (!isSignalingMessage(msg)) return;

      if (msg.type === 'offer') {
        const connection = createPC();
        await connection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        for (const c of pendingCandidates) {
          await connection.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        pendingCandidates = [];
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        send({ type: 'answer', sdp: answer.sdp });
      } else if (msg.type === 'answer') {
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        for (const c of pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        pendingCandidates = [];
      } else if (msg.type === 'candidate') {
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
        } else {
          pendingCandidates.push(msg.candidate);
        }
      }
    } catch {
      // Decryption failed — wrong PIN, stale secret, or corrupted message.
    }
  };

  ws.onclose = (event) => {
    if (!sessionEnded) {
      endSession(socketErrored ? 'Connection failed.' : describeSocketClose(event));
    }
  };

  if (sessionEnded) {
    teardownSession(true);
    return;
  }

  // Keep the session reachable for later navigation teardown.
  activeSessionTeardown = teardownSession;
}
