// ponytail: mesh + public STUN only; symmetric NAT needs a TURN server
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export function shouldShowVideoTrack(track) {
  return !!(track && track.kind === 'video' && track.readyState === 'live');
}

export function pickTileTracks(stream, camOn = true) {
  if (!stream) return { audio: [], video: [] };
  return {
    audio: stream.getAudioTracks(),
    video: camOn ? stream.getVideoTracks().filter(shouldShowVideoTrack) : [],
  };
}

export function getVideoTransceiver(pc) {
  if (!pc?.getTransceivers) return null;
  return pc.getTransceivers().find((t) => {
    const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
    return kind === 'video';
  }) || null;
}

export function getVideoSender(pc) {
  return getVideoTransceiver(pc)?.sender || pc.getSenders?.().find((s) => s.track?.kind === 'video') || null;
}

function ensureVideoSendrecv(pc) {
  const t = getVideoTransceiver(pc);
  if (t && t.direction !== 'sendrecv') t.direction = 'sendrecv';
}

function paintVideoEl(video, stream, tile, camOn) {
  if (!video) return;
  const { audio, video: vids } = pickTileTracks(stream, camOn);
  const show = vids.length > 0;
  tile?.classList.toggle('has-video', show);
  if (tile) tile.dataset.camOn = camOn ? '1' : '0';
  if (!show) {
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    if (audio.length) {
      video.srcObject = new MediaStream(audio);
      video.play().catch(() => {});
    }
    return;
  }
  video.srcObject = new MediaStream([...audio, ...vids]);
  video.play().catch(() => {});
}

export function createVoiceCall({ socket, getJoined, getMyId, stageEl, onUi }) {
  const peers = new Map();
  let localStream = null;
  let inCall = false;
  let muted = false;
  let camOn = false;
  let camBusy = false;
  let remotePeers = [];
  let localTile = null;
  const watchedTracks = new WeakSet();

  function emitUi(error) {
    onUi?.({ inCall, muted, camOn, peers: remotePeers, error: error || '' });
  }

  function paintLocal() {
    paintVideoEl(localTile?.video, localStream, localTile?.tile, camOn);
  }

  function paintPeer(entry) {
    if (!entry) return;
    const recv = getVideoTransceiver(entry.pc)?.receiver?.track;
    if (recv?.kind === 'video') {
      if (!entry.rawStream) entry.rawStream = new MediaStream();
      entry.rawStream.getVideoTracks().forEach((old) => {
        if (old !== recv) entry.rawStream.removeTrack(old);
      });
      if (!entry.rawStream.getTracks().includes(recv)) entry.rawStream.addTrack(recv);
      watchPeerTracks(entry);
    }
    if (entry.rawStream) {
      entry.rawStream.getTracks().forEach((t) => {
        if (t.readyState === 'ended') entry.rawStream.removeTrack(t);
      });
    }
    paintVideoEl(entry.video, entry.rawStream, entry.tile, !!entry.camOn);
  }

  function watchPeerTracks(entry) {
    if (!entry?.rawStream) return;
    for (const t of entry.rawStream.getTracks()) {
      if (watchedTracks.has(t)) continue;
      watchedTracks.add(t);
      const bump = () => paintPeer(entry);
      t.addEventListener('mute', bump);
      t.addEventListener('unmute', bump);
      t.addEventListener('ended', () => {
        entry.rawStream?.removeTrack(t);
        bump();
      });
    }
  }

  function peerName(id) {
    return remotePeers.find((p) => p.socketId === id)?.name || 'Peer';
  }

  function makeTile(labelText, video, local = false) {
    const tile = document.createElement('div');
    tile.className = `room-call-tile${local ? ' local' : ''}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local;
    if (local) video.classList.add('mirror');
    const name = document.createElement('span');
    name.className = 'room-call-tile-name';
    name.textContent = labelText;
    tile.append(video, name);
    stageEl?.appendChild(tile);
    return { tile, video, name };
  }

  function ensureLocalTile() {
    if (localTile || !stageEl) return;
    const video = document.createElement('video');
    localTile = makeTile('You', video, true);
    paintLocal();
  }

  function closePeer(id) {
    const entry = peers.get(id);
    if (!entry) return;
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.close();
    entry.tile?.remove();
    peers.delete(id);
  }

  function hangupLocal() {
    for (const id of [...peers.keys()]) closePeer(id);
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    inCall = false;
    muted = false;
    camOn = false;
    camBusy = false;
    localTile?.tile.remove();
    localTile = null;
    stageEl?.classList.add('hidden');
  }

  function stopLocalVideoTracks() {
    if (!localStream) return;
    localStream.getVideoTracks().forEach((t) => {
      t.stop();
      localStream.removeTrack(t);
    });
  }

  function peerEntry(id, { asOfferer } = {}) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection(ICE);
    const pendingIce = [];
    const video = document.createElement('video');
    const { tile, name } = makeTile(peerName(id), video);
    const entry = {
      pc,
      pendingIce,
      video,
      tile,
      name,
      videoSender: null,
      rawStream: null,
      camOn: false,
    };
    peers.set(id, entry);

    localStream?.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));
    if (asOfferer) {
      entry.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('room:call', { action: 'signal', to: id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      if (!entry.rawStream) entry.rawStream = new MediaStream();
      if (e.track.kind === 'video') {
        entry.rawStream.getVideoTracks().forEach((old) => {
          if (old !== e.track) entry.rawStream.removeTrack(old);
        });
      }
      if (!entry.rawStream.getTracks().includes(e.track)) entry.rawStream.addTrack(e.track);
      e.streams[0]?.getAudioTracks().forEach((t) => {
        if (!entry.rawStream.getTracks().includes(t)) entry.rawStream.addTrack(t);
      });
      watchPeerTracks(entry);
      paintPeer(entry);
    };
    return entry;
  }

  async function bindLocalVideo(entry, track) {
    if (!entry || entry.pc.signalingState === 'closed') return;
    ensureVideoSendrecv(entry.pc);
    entry.videoSender = getVideoSender(entry.pc) || entry.videoSender;
    if (entry.videoSender) {
      await entry.videoSender.replaceTrack(track);
      return;
    }
    // Offer always adds a video transceiver. Don't addTrack before SDP — extra m-line sticks later cycles.
    if (!track || !entry.pc.remoteDescription) return;
    entry.videoSender = entry.pc.addTrack(track, localStream);
  }

  async function offerTo(id) {
    if (id === getMyId()) return;
    const entry = peerEntry(id, { asOfferer: true });
    const localVideo = localStream?.getVideoTracks().find((t) => t.readyState === 'live') || null;
    if (localVideo) await bindLocalVideo(entry, localVideo);
    ensureVideoSendrecv(entry.pc);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    socket.emit('room:call', { action: 'signal', to: id, data: { desc: entry.pc.localDescription } });
  }

  async function handleSignal(from, data) {
    if (!inCall || from === getMyId()) return;
    const entry = peerEntry(from);
    if (data.desc) {
      await entry.pc.setRemoteDescription(data.desc);
      ensureVideoSendrecv(entry.pc);
      entry.videoSender = getVideoSender(entry.pc) || entry.videoSender;
      const localVideo = localStream?.getVideoTracks().find((t) => t.readyState === 'live') || null;
      if (localVideo) await bindLocalVideo(entry, localVideo);
      for (const c of entry.pendingIce) {
        await entry.pc.addIceCandidate(c).catch(() => {});
      }
      entry.pendingIce.length = 0;
      if (data.desc.type === 'offer') {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        socket.emit('room:call', { action: 'signal', to: from, data: { desc: entry.pc.localDescription } });
      }
    } else if (data.candidate) {
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pendingIce.push(data.candidate);
    }
  }

  function syncState(list) {
    remotePeers = Array.isArray(list) ? list : [];
    if (inCall) {
      const live = new Set(remotePeers.map((p) => p.socketId));
      for (const id of [...peers.keys()]) {
        if (!live.has(id)) closePeer(id);
      }
      for (const p of remotePeers) {
        if (p.socketId === getMyId()) continue;
        const entry = peers.get(p.socketId);
        if (!entry) continue;
        entry.name.textContent = p.name;
        entry.camOn = !!p.camOn;
        paintPeer(entry);
      }
    }
    emitUi();
  }

  async function join() {
    if (!getJoined() || inCall) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      emitUi('Mic permission blocked — allow microphone to join the call.');
      return;
    }
    inCall = true;
    muted = false;
    camOn = false;
    stageEl?.classList.remove('hidden');
    ensureLocalTile();
    emitUi();
    socket.emit('room:call', { action: 'join' }, async (reply) => {
      if (reply?.error || !inCall) {
        hangupLocal();
        emitUi(reply?.error || 'Could not join call.');
        return;
      }
      const others = (reply.peers || []).filter((p) => p.socketId !== getMyId());
      for (const p of others) await offerTo(p.socketId);
    });
  }

  function leave() {
    if (!inCall) return;
    socket.emit('room:call', { action: 'leave' });
    hangupLocal();
    emitUi();
  }

  function reset() {
    hangupLocal();
    emitUi();
  }

  function toggleMute() {
    if (!inCall || !localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    emitUi();
  }

  async function toggleCam() {
    if (!inCall || !localStream || camBusy) return;
    camBusy = true;
    try {
      if (camOn) {
        for (const entry of peers.values()) {
          await bindLocalVideo(entry, null);
        }
        stopLocalVideoTracks();
        camOn = false;
        paintLocal();
        socket.emit('room:call', { action: 'cam', on: false });
        emitUi();
        return;
      }
      let extra;
      try {
        extra = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 } },
          audio: false,
        });
      } catch {
        emitUi('Camera permission blocked — allow camera for video.');
        return;
      }
      stopLocalVideoTracks();
      const track = extra.getVideoTracks()[0];
      extra.getTracks().forEach((t) => {
        if (t !== track) t.stop();
      });
      localStream.addTrack(track);
      camOn = true;
      for (const entry of peers.values()) {
        await bindLocalVideo(entry, track);
      }
      paintLocal();
      socket.emit('room:call', { action: 'cam', on: true });
      emitUi();
    } finally {
      camBusy = false;
    }
  }

  socket.on('room:call', (ev) => {
    if (!ev) return;
    if (ev.action === 'state') syncState(ev.peers);
    if (ev.action === 'signal' && ev.from) handleSignal(ev.from, ev.data || {}).catch(() => {});
  });

  return {
    join,
    leave,
    toggleMute,
    toggleCam,
    syncState,
    reset,
    get inCall() { return inCall; },
  };
}

export function pickRecorderMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
}

export function recorderExt(mime) {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}
