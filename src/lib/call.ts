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

function isSignalingMessage(msg: unknown): msg is SignalingMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const { type } = msg as { type?: unknown };
  return type === 'offer' || type === 'answer' || type === 'candidate';
}

const supportsE2EE =
  typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;

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
    if (!active) badge.style.opacity = '0.5';
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
  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let localStream: MediaStream | null = null;
  let stopOrb: (() => void) | null = null;
  let remoteStream: MediaStream | null = null;
  let videoEnabled = false;
  let pendingCandidates: RTCIceCandidateInit[] = [];

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
    setState('disconnected');
    const s = document.getElementById('status-text');
    if (s) s.textContent = 'Microphone access denied.';
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
    setState('disconnected');
    const s = document.getElementById('status-text');
    if (s) s.textContent = 'Failed to connect to relay server.';
    return;
  }

  // 3. Derive keys from the public room ID plus the secret share link fragment.
  const joinProof = await deriveAdmissionProof(roomId, shareSecret, pin);
  const sigKey = await deriveSignalingKey(roomId, shareSecret, pin);
  const callKey = await deriveCallKey(roomId, shareSecret, pin);
  const callKeyRaw = await crypto.subtle.exportKey('raw', callKey);

  // 4. Encrypted signaling helpers
  async function send(data: object) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(await encryptSignaling(sigKey, data));
    }
  }

  // 5. WebRTC peer connection
  function createPC() {
    pendingCandidates = [];

    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });

    localStream!.getTracks().forEach((t) => pc!.addTrack(t, localStream!));

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'candidate', candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
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
        document.getElementById('video-section')?.classList.remove('hidden');

        // Apply E2EE to new video receiver (for renegotiation after initial connection)
        if (supportsE2EE && pc?.connectionState === 'connected') {
          const receiver = pc.getReceivers().find((r) => r.track === e.track);
          if (receiver?.track) {
            const w = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
            w.postMessage({ type: 'setKey', key: callKeyRaw });
            receiver.transform = new RTCRtpScriptTransform(w, { direction: 'decrypt', kind: 'video' });
          }
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected') {
        setState('connected');
        document.getElementById('share-section')?.classList.add('hidden');

        if (!stopOrb && remoteStream) stopOrb = startOrbReactivity(remoteStream);

        // Safety numbers
        const local = pc.localDescription?.sdp || '';
        const remote = pc.remoteDescription?.sdp || '';
        computeVerificationCode(local, remote).then(showVerificationCode);

        // Apply E2EE
        if (supportsE2EE) applyE2ee(pc, callKeyRaw);
        else showE2eeBadge(false);
      }
      if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') {
        cleanup();
        setState('disconnected');
      }
    };

    pc.onnegotiationneeded = async () => {
      if (pc?.connectionState !== 'connected') return;
      if (pc?.signalingState !== 'stable') return;
      try {
        const offer = await pc!.createOffer();
        if (pc?.signalingState !== 'stable') return;
        await pc!.setLocalDescription(offer);
        send({ type: 'offer', sdp: offer.sdp });
      } catch { /* ignore */ }
    };

    return pc;
  }

  // 6. Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const joinUrl = new URL(`${proto}//${location.host}/ws`);
  joinUrl.searchParams.set('room', roomId);
  joinUrl.searchParams.set('proof', joinProof);
  ws = new WebSocket(joinUrl);

  ws.onopen = () => setState('waiting');
  ws.onerror = () => {
    setState('disconnected');
    const s = document.getElementById('status-text');
    if (s) s.textContent = 'Connection failed.';
  };

  ws.onmessage = async (event) => {
    const raw = event.data as string;

    // Control messages from server (unencrypted JSON)
    try {
      const ctrl: unknown = JSON.parse(raw);
      if (typeof ctrl === 'object' && ctrl !== null && 'type' in ctrl) {
        const { type } = ctrl as { type: unknown };
        if (type === 'peer-joined') {
          // We were here first — create offer
          createPC();
          const offer = await pc!.createOffer();
          await pc!.setLocalDescription(offer);
          send({ type: 'offer', sdp: offer.sdp });
          return;
        }
        if (type === 'peer-left') {
          cleanup();
          setState('waiting');
          document.getElementById('share-section')?.classList.remove('hidden');
          return;
        }
      }
    } catch { /* not JSON — must be encrypted */ }

    // Encrypted signaling from peer
    try {
      const msg = await decryptSignaling(sigKey, raw);
      if (!isSignalingMessage(msg)) return;

      if (msg.type === 'offer') {
        if (!pc) createPC();
        await pc!.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        for (const c of pendingCandidates) {
          await pc!.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        pendingCandidates = [];
        const answer = await pc!.createAnswer();
        await pc!.setLocalDescription(answer);
        send({ type: 'answer', sdp: answer.sdp });
      } else if (msg.type === 'answer') {
        await pc!.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        for (const c of pendingCandidates) {
          await pc!.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
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
      // Decryption failed — wrong PIN or corrupted message
    }
  };

  ws.onclose = () => {
    if (document.getElementById('app')?.dataset.state !== 'disconnected') {
      cleanup();
      setState('disconnected');
    }
  };

  // 7. Cleanup
  function cleanup() {
    pc?.close();
    pc = null;
    pendingCandidates = [];
    stopOrb?.();
    stopOrb = null;

    const audio = document.getElementById('remote-audio') as HTMLAudioElement;
    if (audio) audio.srcObject = null;
    const video = document.getElementById('remote-video') as HTMLVideoElement;
    if (video) video.srcObject = null;
    document.getElementById('video-section')?.classList.add('hidden');
    document.getElementById('verification-code')?.classList.add('hidden');
    document.getElementById('e2ee-badge')?.classList.add('hidden');
  }

  // 8. UI controls
  document.getElementById('toggle-mic')?.addEventListener('click', () => {
    const t = localStream?.getAudioTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      document.getElementById('toggle-mic')?.classList.toggle('control-off', !t.enabled);
      document.getElementById('mic-on')?.classList.toggle('hidden', !t.enabled);
      document.getElementById('mic-off')?.classList.toggle('hidden', t.enabled);
    }
  });

  document.getElementById('toggle-video')?.addEventListener('click', async () => {
    if (!videoEnabled) {
      try {
        const vs = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        const vt = vs.getVideoTracks()[0];
        localStream?.addTrack(vt);
        pc?.addTrack(vt, localStream!);

        // Apply E2EE to new video sender
        if (supportsE2EE && pc) {
          const sender = pc.getSenders().find((s) => s.track === vt);
          if (sender?.track) {
            const w = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
            w.postMessage({ type: 'setKey', key: callKeyRaw });
            sender.transform = new RTCRtpScriptTransform(w, { direction: 'encrypt', kind: 'video' });
          }
        }

        const lv = document.getElementById('local-video') as HTMLVideoElement;
        if (lv) {
          lv.srcObject = new MediaStream([vt]);
          lv.play().catch(() => {});
        }
        document.getElementById('video-section')?.classList.remove('hidden');
        videoEnabled = true;
        document.getElementById('toggle-video')?.classList.remove('control-off');
        document.getElementById('vid-on')?.classList.remove('hidden');
        document.getElementById('vid-off')?.classList.add('hidden');
      } catch { /* camera denied */ }
    } else {
      const vt = localStream?.getVideoTracks()[0];
      if (vt) {
        vt.stop();
        localStream?.removeTrack(vt);
        const sender = pc?.getSenders().find((s) => s.track === vt);
        if (sender) pc?.removeTrack(sender);
      }
      videoEnabled = false;
      document.getElementById('toggle-video')?.classList.add('control-off');
      document.getElementById('vid-on')?.classList.add('hidden');
      document.getElementById('vid-off')?.classList.remove('hidden');
      const rv = document.getElementById('remote-video') as HTMLVideoElement;
      if (!rv?.srcObject || !(rv.srcObject as MediaStream).getVideoTracks().length) {
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
    ws?.close();
    ws = null;
    setState('disconnected');
  });
}
