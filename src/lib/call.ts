import {
  deriveCallSecrets,
  encryptSignaling,
  decryptSignaling,
  computeVerificationCode,
} from './crypto';
import { formatRoomPhrase } from './room-phrase';

type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

type ServerFrame =
  | { source: 'server'; type: 'peer-joined' | 'peer-left' }
  | { source: 'server'; type: 'signal'; payload: string };

type AppState = 'idle' | 'requesting-media' | 'connecting' | 'waiting' | 'connected' | 'disconnected';

const supportsE2EE =
  typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;
let activeSessionTeardown: ((silent?: boolean) => void) | null = null;
let animFrameId: number | null = null;

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
    statusDot.className = 'status-dot ' + (
      state === 'requesting-media' || state === 'connecting' ? 'waiting' : state
    );
  }

  if (statusText && messages[state]) statusText.textContent = messages[state];

  if (state === 'disconnected') {
    document.getElementById('share-section')?.classList.add('hidden');
    document.getElementById('controls')?.classList.add('hidden');
    document.getElementById('verification-panel')?.classList.add('hidden');
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

function setVerificationUi(code: string | null, verified: boolean) {
  const panel = document.getElementById('verification-panel');
  const codeEl = document.getElementById('verification-code');
  const button = document.getElementById('verify-call') as HTMLButtonElement | null;
  const hint = document.getElementById('verification-hint');

  if (!panel || !codeEl || !button || !hint) return;

  if (!code) {
    panel.classList.add('hidden');
    codeEl.textContent = '';
    hint.textContent = 'Read this code aloud on both devices. Matching numbers detect active interception.';
    button.disabled = false;
    button.classList.remove('opacity-60', 'cursor-default');
    button.textContent = 'Codes match';
    return;
  }

  panel.classList.remove('hidden');
  codeEl.textContent = code;
  button.disabled = verified;
  button.classList.toggle('opacity-60', verified);
  button.classList.toggle('cursor-default', verified);
  button.textContent = verified ? 'Verified' : 'Codes match';
  hint.textContent = verified
    ? 'Safety numbers matched.'
    : 'Read this code aloud on both devices. Matching numbers detect active interception.';
}

function showE2eeBadge(active: boolean) {
  const badge = document.getElementById('e2ee-badge');
  const status = document.getElementById('e2ee-status');

  if (!badge || !status) return;

  badge.classList.remove('hidden');
  status.textContent = active ? 'E2EE' : 'DTLS only';
  badge.style.opacity = active ? '1' : '0.5';
}

function hideE2eeBadge() {
  document.getElementById('e2ee-badge')?.classList.add('hidden');
}

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

function applyE2ee(pc: RTCPeerConnection, keyRaw: ArrayBuffer) {
  if (!supportsE2EE) return;

  const apply = (
    transceiver: RTCRtpSender | RTCRtpReceiver,
    direction: 'encrypt' | 'decrypt',
  ) => {
    if (!transceiver.track) return;
    const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'setKey', key: keyRaw });
    transceiver.transform = new RTCRtpScriptTransform(worker, {
      direction,
      kind: transceiver.track.kind,
    });
  };

  pc.getSenders().forEach((sender) => apply(sender, 'encrypt'));
  pc.getReceivers().forEach((receiver) => apply(receiver, 'decrypt'));
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/turn-credentials');
    if (!res.ok) return [];

    const data = await res.json() as { iceServers: RTCIceServer[] };
    return data.iceServers;
  } catch {
    return [];
  }
}

export async function initCall(roomPhrase: string): Promise<void> {
  activeSessionTeardown?.(true);

  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let localStream: MediaStream | null = null;
  let remoteStream: MediaStream | null = null;
  let stopOrb: (() => void) | null = null;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let callKeyRaw: ArrayBuffer | null = null;
  let signalingKey: CryptoKey | null = null;
  let roomTag = '';
  let videoEnabled = false;
  let sessionEnded = false;
  let verificationCode: string | null = null;
  let verificationConfirmed = false;

  function updateVideoSectionVisibility() {
    const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().length);
    document.getElementById('video-section')?.classList.toggle('hidden', !videoEnabled && !hasRemoteVideo);
  }

  function updateVerificationState() {
    setVerificationUi(verificationCode, verificationConfirmed);
    if (verificationCode) {
      setStatusText(verificationConfirmed ? 'Connected — verified' : 'Connected — verify safety number');
    }
  }

  function clearRemoteMedia() {
    remoteStream = null;
    verificationCode = null;
    verificationConfirmed = false;

    const audio = document.getElementById('remote-audio') as HTMLAudioElement | null;
    if (audio) audio.srcObject = null;

    const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
    if (remoteVideo) remoteVideo.srcObject = null;

    setVerificationUi(null, false);
    hideE2eeBadge();
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
        return 'This phrase already has two participants.';
      case 4004:
        return 'Too many join attempts. Wait a moment and try again.';
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

  const copyPhraseButton = document.getElementById('copy-btn') as HTMLButtonElement | null;
  if (copyPhraseButton) {
    copyPhraseButton.onclick = () => {
      navigator.clipboard.writeText(formatRoomPhrase(roomPhrase));
      document.getElementById('copy-icon')?.classList.add('hidden');
      document.getElementById('copied-icon')?.classList.remove('hidden');
      setTimeout(() => {
        document.getElementById('copy-icon')?.classList.remove('hidden');
        document.getElementById('copied-icon')?.classList.add('hidden');
      }, 2000);
    };
  }

  const verifyButton = document.getElementById('verify-call') as HTMLButtonElement | null;
  if (verifyButton) {
    verifyButton.onclick = () => {
      if (!verificationCode || sessionEnded) return;
      verificationConfirmed = true;
      updateVerificationState();
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
  setVerificationUi(null, false);

  // 1. Prepare cryptographic material and TURN relay access before requesting media.
  setState('connecting');
  setStatusText('Preparing secure call...');

  let iceServers: RTCIceServer[] = [];
  try {
    const [secrets, relayServers] = await Promise.all([
      deriveCallSecrets(roomPhrase),
      fetchIceServers(),
    ]);

    roomTag = secrets.roomTag;
    signalingKey = secrets.signalingKey;
    callKeyRaw = await crypto.subtle.exportKey('raw', secrets.callKey);
    iceServers = relayServers;
  } catch {
    endSession('Failed to prepare secure call.');
    return;
  }

  if (!signalingKey || !callKeyRaw) {
    endSession('Failed to prepare secure call.');
    return;
  }

  if (!iceServers.length) {
    endSession('Failed to connect to relay server.');
    return;
  }

  if (sessionEnded) return;

  // 2. Request microphone access only once the call can actually proceed.
  setState('requesting-media');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
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

  async function send(data: object) {
    if (ws?.readyState === WebSocket.OPEN && signalingKey) {
      ws.send(await encryptSignaling(signalingKey, data));
    }
  }

  function createPC() {
    if (pc) return pc;

    pendingCandidates = [];

    const nextPc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });
    pc = nextPc;

    localStream?.getTracks().forEach((track) => nextPc.addTrack(track, localStream!));

    nextPc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'candidate', candidate: event.candidate.toJSON() });
    };

    nextPc.ontrack = (event) => {
      if (event.streams[0]) {
        remoteStream = event.streams[0];
      } else {
        if (!remoteStream) remoteStream = new MediaStream();
        if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
      }

      const audio = document.getElementById('remote-audio') as HTMLAudioElement | null;
      if (audio) {
        audio.srcObject = remoteStream;
        audio.play().catch(() => {});
      }

      if (!stopOrb && nextPc.connectionState === 'connected' && remoteStream) {
        stopOrb = startOrbReactivity(remoteStream);
      }

      if (event.track.kind === 'video') {
        const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
        if (remoteVideo) {
          remoteVideo.srcObject = remoteStream;
          remoteVideo.play().catch(() => {});
        }

        updateVideoSectionVisibility();

        if (supportsE2EE && callKeyRaw && nextPc.connectionState === 'connected') {
          const receiver = nextPc.getReceivers().find((candidate) => candidate.track === event.track);
          if (receiver?.track) {
            const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
            worker.postMessage({ type: 'setKey', key: callKeyRaw });
            receiver.transform = new RTCRtpScriptTransform(worker, { direction: 'decrypt', kind: 'video' });
          }
        }
      }
    };

    nextPc.onconnectionstatechange = () => {
      if (nextPc.connectionState === 'connected') {
        setState('connected');
        document.getElementById('share-section')?.classList.add('hidden');

        if (!stopOrb && remoteStream) stopOrb = startOrbReactivity(remoteStream);

        const localSdp = nextPc.localDescription?.sdp || '';
        const remoteSdp = nextPc.remoteDescription?.sdp || '';
        computeVerificationCode(localSdp, remoteSdp).then((code) => {
          if (sessionEnded || pc !== nextPc) return;
          verificationCode = code;
          verificationConfirmed = false;
          updateVerificationState();
        });

        if (supportsE2EE && callKeyRaw) {
          applyE2ee(nextPc, callKeyRaw);
          showE2eeBadge(true);
        } else {
          showE2eeBadge(false);
        }
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
      } catch {
        return;
      }
    };

    return nextPc;
  }

  // 3. Connect to the signaling relay using only the derived room tag.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const joinUrl = new URL(`${proto}//${location.host}/ws`);
  joinUrl.searchParams.set('roomTag', roomTag);
  ws = new WebSocket(joinUrl);
  let socketErrored = false;

  ws.onopen = () => {
    if (!sessionEnded) setState('waiting');
  };

  ws.onerror = () => {
    socketErrored = true;
  };

  ws.onmessage = async (event) => {
    if (sessionEnded || !signalingKey) return;

    let frame: unknown;
    try {
      frame = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (!isServerFrame(frame)) return;

    if (frame.type === 'peer-joined') {
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
      const msg = await decryptSignaling(signalingKey, frame.payload);
      if (!isSignalingMessage(msg)) return;

      if (msg.type === 'offer') {
        const connection = createPC();
        await connection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        for (const candidate of pendingCandidates) {
          await connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
        pendingCandidates = [];
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        send({ type: 'answer', sdp: answer.sdp });
      } else if (msg.type === 'answer') {
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        for (const candidate of pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
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
      return;
    }
  };

  ws.onclose = (event) => {
    if (!sessionEnded) {
      endSession(socketErrored ? 'Connection failed.' : describeSocketClose(event));
    }
  };

  activeSessionTeardown = teardownSession;
}
