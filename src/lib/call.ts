import {
  deriveSignalingKey,
  deriveCallKey,
  encryptSignaling,
  decryptSignaling,
  computeVerificationCode,
  arrayBufferToBase64,
} from './crypto';

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

  const apply = (transceiver: RTCRtpSender | RTCRtpReceiver, direction: string) => {
    if (!transceiver.track) return;
    const w = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ type: 'setKey', key: keyRaw });
    (transceiver as any).transform = new (window as any).RTCRtpScriptTransform(w, {
      direction,
      kind: transceiver.track.kind,
    });
  };

  pc.getSenders().forEach((s) => apply(s, 'encrypt'));
  pc.getReceivers().forEach((r) => apply(r, 'decrypt'));
  showE2eeBadge(true);
}

// --- Main ---

export async function initCall(roomId: string, pin?: string): Promise<void> {
  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let localStream: MediaStream | null = null;
  let stopOrb: (() => void) | null = null;
  let videoEnabled = false;

  // 1. Get audio
  setState('requesting-media');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
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
    if (res.ok) iceServers = (await res.json()).iceServers;
  } catch { /* */ }

  if (!iceServers.length) {
    setState('disconnected');
    const s = document.getElementById('status-text');
    if (s) s.textContent = 'Failed to connect to relay server.';
    return;
  }

  // 3. Derive keys from room ID + PIN (no key exchange needed)
  const sigKey = await deriveSignalingKey(roomId, pin);
  const callKey = await deriveCallKey(roomId, pin);
  const callKeyRaw = await crypto.subtle.exportKey('raw', callKey);

  // 4. Encrypted signaling helpers
  async function send(data: object) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(await encryptSignaling(sigKey, data));
    }
  }

  // 5. WebRTC peer connection
  function createPC() {
    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
    });

    localStream!.getTracks().forEach((t) => pc!.addTrack(t, localStream!));

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'candidate', candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
      const remote = e.streams[0];
      if (!remote) return;

      const audio = document.getElementById('remote-audio') as HTMLAudioElement;
      if (audio) audio.srcObject = remote;

      setState('connected');
      document.getElementById('share-section')?.classList.add('hidden');

      if (!stopOrb) stopOrb = startOrbReactivity(remote);

      if (e.track.kind === 'video') {
        const vid = document.getElementById('remote-video') as HTMLVideoElement;
        if (vid) vid.srcObject = remote;
        document.getElementById('video-section')?.classList.remove('hidden');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected') {
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

    return pc;
  }

  // 6. Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(roomId)}`);

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
      const ctrl = JSON.parse(raw);
      if (ctrl.type === 'peer-joined') {
        // We were here first — create offer
        createPC();
        const offer = await pc!.createOffer();
        await pc!.setLocalDescription(offer);
        send({ type: 'offer', sdp: offer.sdp });
        return;
      }
      if (ctrl.type === 'peer-left') {
        cleanup();
        setState('waiting');
        document.getElementById('share-section')?.classList.remove('hidden');
        return;
      }
    } catch { /* not JSON — must be encrypted */ }

    // Encrypted signaling from peer
    try {
      const msg = await decryptSignaling(sigKey, raw) as any;

      if (msg.type === 'offer') {
        createPC();
        await pc!.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        const answer = await pc!.createAnswer();
        await pc!.setLocalDescription(answer);
        send({ type: 'answer', sdp: answer.sdp });
      } else if (msg.type === 'answer') {
        await pc?.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      } else if (msg.type === 'candidate') {
        await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate));
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
        const lv = document.getElementById('local-video') as HTMLVideoElement;
        if (lv) lv.srcObject = new MediaStream([vt]);
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
