import {
  deriveCallSecrets,
  encryptSignaling,
  decryptSignaling,
  computeVerificationCode,
} from './crypto';
import { formatRoomPhrase } from './room-phrase';

type PeerEngine = 'chromium' | 'webkit' | 'firefox' | 'unknown';

type PeerCapabilities = {
  engine: PeerEngine;
  sframe: boolean;
};

type SignalingMessage =
  | { type: 'hello'; capabilities: PeerCapabilities }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

type ServerFrame =
  | { source: 'server'; type: 'peer-joined' | 'peer-left' }
  | { source: 'server'; type: 'signal'; payload: string };

type AppState = 'idle' | 'requesting-media' | 'connecting' | 'waiting' | 'connected' | 'disconnected';

const supportsMediaE2ee =
  typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window;
const audioCodecPreference = ['audio/opus', 'audio/PCMU', 'audio/PCMA'];
const videoCodecPreference = ['video/H264', 'video/VP8'];

let activeSessionTeardown: ((silent?: boolean) => void) | null = null;
let animFrameId: number | null = null;

function isPeerCapabilities(value: unknown): value is PeerCapabilities {
  if (typeof value !== 'object' || value === null) return false;

  const { engine, sframe } = value as {
    engine?: unknown;
    sframe?: unknown;
  };

  return (
    typeof sframe === 'boolean' &&
    (engine === 'chromium' || engine === 'webkit' || engine === 'firefox' || engine === 'unknown')
  );
}

function isSignalingMessage(msg: unknown): msg is SignalingMessage {
  if (typeof msg !== 'object' || msg === null) return false;

  const { type, capabilities, sdp, candidate } = msg as {
    type?: unknown;
    capabilities?: unknown;
    sdp?: unknown;
    candidate?: unknown;
  };

  if (type === 'hello') return isPeerCapabilities(capabilities);
  if ((type === 'offer' || type === 'answer') && typeof sdp === 'string') return true;
  return type === 'candidate' && typeof candidate === 'object' && candidate !== null;
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

function detectPeerEngine(): PeerEngine {
  const userAgent = navigator.userAgent;

  if (/Firefox\//.test(userAgent)) return 'firefox';

  if (/CriOS\//.test(userAgent)) return 'webkit';

  if (/Edg\//.test(userAgent) || /Chrome\//.test(userAgent) || /Chromium\//.test(userAgent) || /OPR\//.test(userAgent)) {
    return 'chromium';
  }

  if (/AppleWebKit\//.test(userAgent) && /Safari\//.test(userAgent)) {
    return 'webkit';
  }

  return 'unknown';
}

function shouldUseMediaE2ee(localCapabilities: PeerCapabilities, remoteCapabilities: PeerCapabilities | null): boolean {
  if (!remoteCapabilities) return false;
  if (!localCapabilities.sframe || !remoteCapabilities.sframe) return false;
  if (localCapabilities.engine === 'unknown' || remoteCapabilities.engine === 'unknown') return false;

  return localCapabilities.engine === remoteCapabilities.engine;
}

function sortCodecs(kind: 'audio' | 'video', preferredMimeTypes: string[]): RTCRtpCodecCapability[] {
  if (typeof RTCRtpSender.getCapabilities !== 'function') return [];

  const codecs = RTCRtpSender.getCapabilities(kind)?.codecs ?? [];
  if (!codecs.length) return [];

  const preferredOrder = new Map(
    preferredMimeTypes.map((mimeType, index) => [mimeType.toLowerCase(), index]),
  );

  return [...codecs].sort((left, right) => {
    const leftRank = preferredOrder.get(left.mimeType.toLowerCase()) ?? preferredMimeTypes.length;
    const rightRank = preferredOrder.get(right.mimeType.toLowerCase()) ?? preferredMimeTypes.length;
    return leftRank - rightRank;
  });
}

function applyCodecPreferences(transceiver: RTCRtpTransceiver, kind: 'audio' | 'video') {
  if (typeof transceiver.setCodecPreferences !== 'function') return;

  const codecs = sortCodecs(kind, kind === 'audio' ? audioCodecPreference : videoCodecPreference);
  if (codecs.length) transceiver.setCodecPreferences(codecs);
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
    document.getElementById('call-media-stage')?.classList.add('hidden');
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

function showE2eeBadge(mode: 'e2ee' | 'dtls') {
  const badge = document.getElementById('e2ee-badge');
  const status = document.getElementById('e2ee-status');

  if (!badge || !status) return;

  badge.classList.remove('hidden');
  status.textContent = mode === 'e2ee' ? 'E2EE' : 'DTLS only';
  badge.style.opacity = mode === 'e2ee' ? '1' : '0.65';
}

function hideE2eeBadge() {
  document.getElementById('e2ee-badge')?.classList.add('hidden');
}

function startStageReactivity(stream: MediaStream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.82;

  const data = new Uint8Array(analyser.frequencyBinCount);
  const mediaStage = document.getElementById('call-media-stage');

  ctx.resume().catch(() => {});

  function tick() {
    analyser.getByteFrequencyData(data);
    const averageLevel = data.reduce((sum, value) => sum + value, 0) / data.length / 255;
    const talkLevel = Math.min(averageLevel * 1.5, 1);

    if (mediaStage) {
      mediaStage.style.setProperty('--talk-level', talkLevel.toFixed(3));
      mediaStage.style.setProperty('--stripe-speed', `${Math.max(1.7, 3 - talkLevel * 1.1).toFixed(2)}s`);
    }

    animFrameId = requestAnimationFrame(tick);
  }

  tick();

  return () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
    ctx.close().catch(() => {});

    if (mediaStage) {
      mediaStage.style.removeProperty('--talk-level');
      mediaStage.style.removeProperty('--stripe-speed');
    }
  };
}

function applyTransform(
  target: RTCRtpSender | RTCRtpReceiver,
  direction: 'encrypt' | 'decrypt',
  keyRaw: ArrayBuffer,
) {
  if (!supportsMediaE2ee || !target.track) return;

  const worker = new Worker(new URL('./e2ee-worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'setKey', key: keyRaw });
  target.transform = new RTCRtpScriptTransform(worker, {
    direction,
    kind: target.track.kind,
  });
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
  let localAudioStream: MediaStream | null = null;
  let localVideoTrack: MediaStreamTrack | null = null;
  let remoteStream: MediaStream | null = null;
  let audioTransceiver: RTCRtpTransceiver | null = null;
  let videoTransceiver: RTCRtpTransceiver | null = null;
  let stopStage: (() => void) | null = null;
  let pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  let queuedLocalCandidates: RTCIceCandidateInit[] = [];
  let callKeyRaw: ArrayBuffer | null = null;
  let signalingKey: CryptoKey | null = null;
  let roomTag = '';
  let videoEnabled = false;
  let remoteVideoActive = false;
  let sessionEnded = false;
  let verificationCode: string | null = null;
  let verificationConfirmed = false;
  let shouldInitiateOffer = false;
  let initialOfferSent = false;
  let peerAvailable = false;
  let localCapabilities: PeerCapabilities = {
    engine: detectPeerEngine(),
    sframe: supportsMediaE2ee,
  };
  let remoteCapabilities: PeerCapabilities | null = null;
  let mediaE2eeActive = false;
  let socketErrored = false;

  const transformedSenders = new WeakSet<RTCRtpSender>();
  const transformedReceivers = new WeakSet<RTCRtpReceiver>();

  function syncStageUi() {
    const stage = document.getElementById('call-media-stage');
    const remoteVideo = document.getElementById('remote-video');
    const localPreview = document.getElementById('local-preview-shell');
    const micIcon = document.getElementById('stage-mic-icon');
    const videoIcon = document.getElementById('stage-video-icon');

    const videoMode = videoEnabled || remoteVideoActive;

    if (stage) {
      stage.dataset.mode = videoMode ? 'video' : 'audio';
      stage.dataset.remoteVideo = remoteVideoActive ? 'true' : 'false';
    }

    remoteVideo?.classList.toggle('hidden', !remoteVideoActive);
    localPreview?.classList.toggle('hidden', !videoEnabled);
    micIcon?.classList.toggle('hidden', videoMode);
    videoIcon?.classList.toggle('hidden', !videoMode);
  }

  function updateVerificationState() {
    setVerificationUi(verificationCode, verificationConfirmed);
    if (verificationCode) {
      setStatusText(verificationConfirmed ? 'Connected — verified' : 'Connected — verify safety number');
    }
  }

  function updateEncryptionMode() {
    mediaE2eeActive = shouldUseMediaE2ee(localCapabilities, remoteCapabilities);
  }

  function syncMediaEncryption() {
    if (!pc || !callKeyRaw || !mediaE2eeActive) return;

    if (audioTransceiver) {
      if (!transformedSenders.has(audioTransceiver.sender) && audioTransceiver.sender.track) {
        applyTransform(audioTransceiver.sender, 'encrypt', callKeyRaw);
        transformedSenders.add(audioTransceiver.sender);
      }

      if (!transformedReceivers.has(audioTransceiver.receiver) && audioTransceiver.receiver.track) {
        applyTransform(audioTransceiver.receiver, 'decrypt', callKeyRaw);
        transformedReceivers.add(audioTransceiver.receiver);
      }
    }

    if (videoTransceiver) {
      if (!transformedSenders.has(videoTransceiver.sender) && videoTransceiver.sender.track) {
        applyTransform(videoTransceiver.sender, 'encrypt', callKeyRaw);
        transformedSenders.add(videoTransceiver.sender);
      }

      if (!transformedReceivers.has(videoTransceiver.receiver) && videoTransceiver.receiver.track) {
        applyTransform(videoTransceiver.receiver, 'decrypt', callKeyRaw);
        transformedReceivers.add(videoTransceiver.receiver);
      }
    }
  }

  function setRemoteVideoState(active: boolean) {
    remoteVideoActive = active;
    syncStageUi();
  }

  function bindRemoteVideoTrack(track: MediaStreamTrack) {
    const refreshRemoteState = () => {
      if (track.readyState === 'ended') {
        setRemoteVideoState(false);
        return;
      }

      setRemoteVideoState(!track.muted);
      if (!track.muted) {
        const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
        remoteVideo?.play().catch(() => {});
      }
    };

    track.onunmute = refreshRemoteState;
    track.onmute = refreshRemoteState;
    track.onended = () => setRemoteVideoState(false);

    refreshRemoteState();
  }

  function clearRemoteMedia() {
    remoteStream = null;
    remoteVideoActive = false;
    verificationCode = null;
    verificationConfirmed = false;

    const audio = document.getElementById('remote-audio') as HTMLAudioElement | null;
    const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
    if (audio) audio.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    stopStage?.();
    stopStage = null;

    setVerificationUi(null, false);
    hideE2eeBadge();
    syncStageUi();
  }

  async function disableLocalVideo(stopTrack = true) {
    const currentTrack = localVideoTrack;
    localVideoTrack = null;
    videoEnabled = false;

    if (videoTransceiver) {
      await videoTransceiver.sender.replaceTrack(null).catch(() => {});
    }

    if (stopTrack && currentTrack) {
      currentTrack.onended = null;
      currentTrack.stop();
    }

    const localVideo = document.getElementById('local-video') as HTMLVideoElement | null;
    if (localVideo) localVideo.srcObject = null;

    setVideoToggleState(false);
    syncStageUi();
  }

  function stopLocalMedia() {
    localAudioStream?.getTracks().forEach((track) => track.stop());
    localAudioStream = null;

    void disableLocalVideo();

    setMicToggleState(true);
  }

  function cleanupPeerConnection() {
    const currentPc = pc;
    pc = null;
    audioTransceiver = null;
    videoTransceiver = null;

    if (currentPc) {
      currentPc.onicecandidate = null;
      currentPc.ontrack = null;
      currentPc.onconnectionstatechange = null;
      currentPc.close();
    }

    pendingRemoteCandidates = [];
    queuedLocalCandidates = [];
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

  async function send(data: SignalingMessage) {
    if (ws?.readyState === WebSocket.OPEN && signalingKey) {
      ws.send(await encryptSignaling(signalingKey, data));
    }
  }

  async function sendHello() {
    await send({ type: 'hello', capabilities: localCapabilities });
  }

  async function flushLocalCandidates() {
    if (!peerAvailable || ws?.readyState !== WebSocket.OPEN || !queuedLocalCandidates.length) return;

    while (queuedLocalCandidates.length) {
      const nextCandidate = queuedLocalCandidates.shift();
      if (!nextCandidate) continue;
      await send({ type: 'candidate', candidate: nextCandidate });
    }
  }

  function ensurePeerConnection(iceServers: RTCIceServer[]) {
    if (pc) return pc;

    const nextPc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });
    pc = nextPc;

    const audioTrack = localAudioStream?.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('Missing microphone track');
    }

    audioTransceiver = nextPc.addTransceiver(audioTrack, { direction: 'sendrecv' });
    videoTransceiver = nextPc.addTransceiver('video', { direction: 'sendrecv' });

    applyCodecPreferences(audioTransceiver, 'audio');
    applyCodecPreferences(videoTransceiver, 'video');

    nextPc.onicecandidate = (event) => {
      if (!event.candidate) return;

      queuedLocalCandidates.push(event.candidate.toJSON());
      void flushLocalCandidates();
    };

    nextPc.ontrack = (event) => {
      peerAvailable = true;

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

      if (!stopStage && nextPc.connectionState === 'connected' && remoteStream) {
        stopStage = startStageReactivity(remoteStream);
      }

      if (event.track.kind === 'video') {
        const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement | null;
        if (remoteVideo) {
          remoteVideo.srcObject = remoteStream;
        }

        bindRemoteVideoTrack(event.track);
      }

      syncMediaEncryption();
    };

    nextPc.onconnectionstatechange = () => {
      if (nextPc.connectionState === 'connected') {
        setState('connected');
        document.getElementById('share-section')?.classList.add('hidden');

        if (!stopStage && remoteStream) stopStage = startStageReactivity(remoteStream);

        const localSdp = nextPc.localDescription?.sdp || '';
        const remoteSdp = nextPc.remoteDescription?.sdp || '';
        computeVerificationCode(localSdp, remoteSdp).then((code) => {
          if (sessionEnded || pc !== nextPc) return;
          verificationCode = code;
          verificationConfirmed = false;
          updateVerificationState();
        });

        showE2eeBadge(mediaE2eeActive ? 'e2ee' : 'dtls');
      }

      if (nextPc.connectionState === 'failed' || nextPc.connectionState === 'disconnected') {
        endSession('Connection lost.');
      }
    };

    syncMediaEncryption();
    syncStageUi();

    return nextPc;
  }

  async function maybeSendInitialOffer() {
    if (
      sessionEnded ||
      !pc ||
      !shouldInitiateOffer ||
      initialOfferSent ||
      !peerAvailable ||
      !remoteCapabilities
    ) {
      return;
    }

    updateEncryptionMode();
    syncMediaEncryption();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      initialOfferSent = true;
      await send({ type: 'offer', sdp: offer.sdp || '' });
      await flushLocalCandidates();
    } catch {
      initialOfferSent = false;
    }
  }

  activeSessionTeardown = teardownSession;

  const toggleMicButton = document.getElementById('toggle-mic') as HTMLButtonElement | null;
  if (toggleMicButton) {
    toggleMicButton.onclick = () => {
      const track = localAudioStream?.getAudioTracks()[0];
      if (!track) return;

      track.enabled = !track.enabled;
      setMicToggleState(track.enabled);
    };
  }

  const toggleVideoButton = document.getElementById('toggle-video') as HTMLButtonElement | null;
  if (toggleVideoButton) {
    toggleVideoButton.onclick = async () => {
      if (sessionEnded || !pc || !videoTransceiver) return;

      if (!videoEnabled) {
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          });
          const nextTrack = videoStream.getVideoTracks()[0];

          if (!nextTrack) {
            videoStream.getTracks().forEach((track) => track.stop());
            return;
          }

          if (sessionEnded) {
            nextTrack.stop();
            return;
          }

          nextTrack.onended = () => {
            if (localVideoTrack === nextTrack) {
              void disableLocalVideo(false);
            }
          };

          await videoTransceiver.sender.replaceTrack(nextTrack);

          localVideoTrack = nextTrack;
          videoEnabled = true;

          const localVideo = document.getElementById('local-video') as HTMLVideoElement | null;
          if (localVideo) {
            localVideo.srcObject = new MediaStream([nextTrack]);
            localVideo.play().catch(() => {});
          }

          setVideoToggleState(true);
          syncMediaEncryption();
          syncStageUi();
        } catch {
          return;
        }

        return;
      }

      await disableLocalVideo();
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
  syncStageUi();

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

  setState('requesting-media');
  try {
    localAudioStream = await navigator.mediaDevices.getUserMedia({
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

  try {
    ensurePeerConnection(iceServers);
  } catch {
    endSession('Failed to prepare secure call.');
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const joinUrl = new URL(`${proto}//${location.host}/ws`);
  joinUrl.searchParams.set('roomTag', roomTag);
  ws = new WebSocket(joinUrl);

  ws.onopen = () => {
    if (sessionEnded) return;
    setState('waiting');
    void sendHello();
    void flushLocalCandidates();
  };

  ws.onerror = () => {
    socketErrored = true;
  };

  ws.onmessage = async (event) => {
    if (sessionEnded || !signalingKey || !pc) return;

    let frame: unknown;
    try {
      frame = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (!isServerFrame(frame)) return;

    if (frame.type === 'peer-joined') {
      peerAvailable = true;
      shouldInitiateOffer = true;
      void sendHello();
      void flushLocalCandidates();
      void maybeSendInitialOffer();
      return;
    }

    if (frame.type === 'peer-left') {
      endSession('The other person left the call.');
      return;
    }

    try {
      const msg = await decryptSignaling(signalingKey, frame.payload);
      if (!isSignalingMessage(msg)) return;

      peerAvailable = true;

      if (msg.type === 'hello') {
        remoteCapabilities = msg.capabilities;
        updateEncryptionMode();
        syncMediaEncryption();
        void flushLocalCandidates();
        void maybeSendInitialOffer();
        return;
      }

      if (msg.type === 'offer') {
        updateEncryptionMode();
        syncMediaEncryption();

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        for (const candidate of pendingRemoteCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
        pendingRemoteCandidates = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await send({ type: 'answer', sdp: answer.sdp || '' });
        await flushLocalCandidates();
        return;
      }

      if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        for (const candidate of pendingRemoteCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
        pendingRemoteCandidates = [];
        await flushLocalCandidates();
        return;
      }

      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else {
        pendingRemoteCandidates.push(msg.candidate);
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
