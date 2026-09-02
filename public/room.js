import { renderGapGraph } from '/gap-graph.js';
import { avatarHtml } from '/room-avatar.js';
import { createVoiceCall } from '/room-voice.js';
import { loadBoardLib, mountBoard, applyBoardElements, persistBoardFiles, prepareBoardScene, unmountBoard, isRemoteBoardStale, shouldCommitBoardApply, liveElementCount, liveElementIds, shouldFlushBoardScene, resolveBoardFiles } from '/room-board.js';

const $ = (sel) => document.querySelector(sel);
const TAB_SESSION_KEY = 'studyRoomTabSession';

const joinPanel = $('#join-panel');
const roomPanel = $('#room-panel');
const roomCodeInput = $('#room-code');
const displayNameInput = $('#display-name');
const joinBtn = $('#join-room-btn');
const createBtn = $('#create-room-btn');
const joinError = $('#join-error');
const activeRoomCode = $('#active-room-code');
const copyCodeBtn = $('#copy-code-btn');
const presenceList = $('#presence-list');
const roomChat = $('#room-chat');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const imageInput = $('#image-input');
const videoInput = $('#video-input');
const fileInput = $('#file-input');
const attachBtn = $('#attach-btn');
const attachMenu = $('#attach-menu');
const uploadStatus = $('#room-upload-status');
const roomDocument = $('#room-document');
const gapDashboard = $('#gap-dashboard');
const roomPin = $('#room-pin');
const roomTyping = $('#room-typing');
const timerBtn = $('#timer-btn');
const timerMins = $('#timer-mins');
const callBtn = $('#call-btn');
const callMuteBtn = $('#call-mute-btn');
const callCamBtn = $('#call-cam-btn');
const callStatus = $('#call-status');
const callStage = $('#call-stage');
const boardPresentBtn = $('#board-present-btn');
const boardStatus = $('#board-status');
const boardMount = $('#board-mount');

const socket = io({ maxHttpBufferSize: 8e6 });
let joined = false;
let mySocketId = null;
let memberToken = null;
let activeRoomCodeValue = '';
let myName = '';
let activeTimer = null;
const typingNames = new Map();
let lastTypingAt = 0;

socket.on('room:presence', (presence) => renderPresence(presence));
socket.on('room:message', (msg) => appendChatMessage(msg));
socket.on('room:gap-maps', (gapMaps) => renderGapDashboard(gapMaps));
socket.on('room:document', (doc) => renderRoomDocument(doc));
socket.on('room:error', (msg) => showRoomStatus(msg, 'error'));
socket.on('room:typing', ({ name } = {}) => noteTyping(name));
socket.on('room:react', (msg) => applyReact(msg));
socket.on('room:pin', (pin) => renderPin(pin));
socket.on('room:timer', (timer) => applyTimer(timer));

function renderCallUi({ inCall, muted, camOn, peers, error }) {
  const others = (peers || []).filter((p) => p.socketId !== mySocketId);
  const names = others.map((p) => p.name);
  callBtn.textContent = inCall ? 'Leave call' : names.length ? `Join call (${names.length})` : 'Join call';
  callBtn.classList.toggle('in-call', inCall);
  callMuteBtn.classList.toggle('hidden', !inCall);
  callCamBtn.classList.toggle('hidden', !inCall);
  callMuteBtn.textContent = muted ? 'Unmute' : 'Mute';
  callCamBtn.textContent = camOn ? 'Cam off' : 'Cam';
  callCamBtn.classList.toggle('in-call', !!camOn);
  if (error) {
    callStatus.textContent = error;
    callStatus.classList.remove('hidden');
    return;
  }
  if (inCall) {
    callStatus.textContent = names.length ? `In call with ${names.join(', ')}` : 'In call — waiting for others';
    callStatus.classList.remove('hidden');
  } else if (names.length) {
    callStatus.textContent = `${names.join(', ')} in call`;
    callStatus.classList.remove('hidden');
  } else {
    callStatus.textContent = '';
    callStatus.classList.add('hidden');
  }
}

const voiceCall = createVoiceCall({
  socket,
  getJoined: () => joined,
  getMyId: () => mySocketId,
  stageEl: callStage,
  onUi: renderCallUi,
});

function rejoinActiveRoom(name) {
  if (!memberToken || !activeRoomCodeValue) return;
  myName = name;
  socket.emit('room:rejoin', {
    roomCode: activeRoomCodeValue,
    memberToken,
    userName: name,
  }, (reply) => {
    if (reply?.error) return;
    mySocketId = reply.socketId;
    voiceCall.reset();
    renderPresence(reply.state.presence);
    syncChatMessages(reply.state.messages);
    renderGapDashboard(reply.state.gapMaps);
    renderRoomDocument(reply.state.document);
    applyRoomExtras(reply.state);
  });
}

socket.on('connect', () => {
  if (joined) {
    const name = loadTabSession()?.name || displayNameInput.value.trim();
    if (name) rejoinActiveRoom(name);
    return;
  }
  const tabSession = loadTabSession();
  if (!tabSession) return;
  const code = roomCodeFromPath() || roomCodeInput.value.trim();
  if (tabSession.code !== normalizeCode(code)) return;
  socket.emit('room:rejoin', {
    roomCode: tabSession.code,
    memberToken: tabSession.token,
    userName: tabSession.name,
  }, (reply) => {
    if (reply?.error) return;
    mySocketId = reply.socketId;
    enterRoom(reply.state, reply.memberToken, tabSession.name);
  });
});

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function saveTabSession(code, token, name) {
  sessionStorage.setItem(TAB_SESSION_KEY, JSON.stringify({ code, token, name }));
}

function loadTabSession() {
  try {
    return JSON.parse(sessionStorage.getItem(TAB_SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function roomCodeFromPath() {
  const part = location.pathname.replace(/^\/room\/?/, '').split('/')[0];
  return part ? decodeURIComponent(part) : '';
}

function showJoinError(msg) {
  if (!msg) {
    joinError.classList.add('hidden');
    joinError.textContent = '';
    return;
  }
  joinError.textContent = msg;
  joinError.classList.remove('hidden');
}

function showRoomStatus(msg, type = 'loading') {
  if (!msg) {
    uploadStatus.classList.add('hidden');
    uploadStatus.textContent = '';
    return;
  }
  uploadStatus.textContent = msg;
  uploadStatus.className = `room-upload-status ${type}`;
  uploadStatus.classList.remove('hidden');
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const ATTACH_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  file: 25 * 1024 * 1024,
};

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKind(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

function fileCardHtml(m) {
  const label = m.fileName || 'file';
  const ext = label.includes('.') ? label.split('.').pop().toUpperCase() : 'FILE';
  return `<a class="room-file-card" href="${escapeHtml(m.fileUrl)}" target="_blank" rel="noopener" download="${escapeHtml(label)}">
    <span class="room-file-icon" aria-hidden="true">${escapeHtml(ext.slice(0, 4))}</span>
    <span class="room-file-info">
      <strong>${escapeHtml(label)}</strong>
      <span class="room-file-meta">${formatFileSize(m.fileSize)} · Download</span>
    </span>
  </a>`;
}

function renderPresence(presence) {
  presenceList.innerHTML = presence
    .map((p) => {
      const score = p.masteryScore != null ? `${p.masteryScore}%` : '—';
      const you = p.socketId === mySocketId;
      return `<li class="presence-item${you ? ' you' : ''}">
        ${avatarHtml(p.name, 'room-avatar-presence', escapeHtml)}
        <span class="presence-name">${escapeHtml(p.name)}${you ? ' (you)' : ''}</span>
        ${p.inCall ? '<span class="presence-call" title="In voice"></span>' : ''}
        <span class="presence-score">${score}</span>
      </li>`;
    })
    .join('');
}

function msgActionsHtml(m) {
  if (!m?.id || m.type === 'system') return '';
  const reactions = m.reactions || {};
  const buttons = ['🔥', '❓', '✅'].map((emoji) => {
    const names = reactions[emoji] || [];
    const on = myName && names.includes(myName) ? ' on' : '';
    const count = names.length ? `<span class="room-react-n">${names.length}</span>` : '';
    return `<button type="button" class="room-react-btn${on}" data-react="${emoji}">${emoji}${count}</button>`;
  }).join('');
  return `<div class="room-msg-actions">${buttons}<button type="button" class="room-pin-msg" data-pin title="Pin">📌</button></div>`;
}

function userMsgShell(name, bodyHtml, m) {
  const idAttr = m?.id ? ` data-msg-id="${escapeHtml(m.id)}"` : '';
  return `<div class="room-msg room-msg-user"${idAttr}>
    ${avatarHtml(name, 'room-avatar-chat', escapeHtml)}
    <div class="room-msg-body">${bodyHtml}${msgActionsHtml(m)}</div>
  </div>`;
}

function documentMsgHtml(m) {
  return userMsgShell(
    m.name,
    `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
    <div class="room-doc-card">
      <span class="room-doc-label">Shared document</span>
      <strong>${escapeHtml(m.topic)}</strong>
      <p>${escapeHtml(m.summary || '')}</p>
      ${m.previewQuestion ? `<p class="room-doc-preview">Preview: ${escapeHtml(m.previewQuestion)}</p>` : ''}
    </div>`,
    m
  );
}

function chatMsgHtml(m) {
  if (m.type === 'system') {
    const idAttr = m.id ? ` data-msg-id="${escapeHtml(m.id)}"` : '';
    return `<div class="room-msg system"${idAttr}>${escapeHtml(m.text)}</div>`;
  }
  if (m.type === 'image') {
    return userMsgShell(
      m.name,
      `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
      <img class="room-msg-image" src="${escapeHtml(m.imageUrl)}" alt="Shared by ${escapeHtml(m.name)}" />`,
      m
    );
  }
  if (m.type === 'video') {
    return userMsgShell(
      m.name,
      `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
      <video class="room-msg-video" controls muted playsinline preload="metadata" src="${escapeHtml(m.videoUrl)}"></video>`,
      m
    );
  }
  if (m.type === 'audio') {
    return userMsgShell(
      m.name,
      `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
      <audio class="room-msg-audio" controls preload="metadata" src="${escapeHtml(m.audioUrl)}"></audio>`,
      m
    );
  }
  if (m.type === 'file') {
    return userMsgShell(
      m.name,
      `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
      ${fileCardHtml(m)}`,
      m
    );
  }
  if (m.type === 'document') return documentMsgHtml(m);
  return userMsgShell(
    m.name,
    `<span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
    <p class="room-msg-text">${escapeHtml(m.text)}</p>`,
    m
  );
}

function hasChatMessage(id) {
  if (!id) return false;
  return roomChat.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) != null;
}

function syncChatMessages(messages) {
  (messages || []).forEach((m) => appendChatMessage(m));
}

// #room-chat is flex-direction: column-reverse, so the first DOM child renders at
// the visual bottom and stays pinned there no matter when media finishes loading.
function renderChat(messages) {
  roomChat.innerHTML = (messages || [])
    .slice()
    .reverse()
    .map((m) => chatMsgHtml(m))
    .join('');
}

function appendChatMessage(msg) {
  if (!msg || (msg.id && hasChatMessage(msg.id))) return;
  roomChat.insertAdjacentHTML('afterbegin', chatMsgHtml(msg));
}

function renderRoomDocument(doc) {
  if (!doc?.topic) {
    roomDocument.classList.add('hidden');
    roomDocument.innerHTML = '';
    return;
  }
  roomDocument.classList.remove('hidden');
  roomDocument.innerHTML = `
    <div class="room-doc-banner">
      <span class="room-doc-label">Room study material</span>
      <strong>${escapeHtml(doc.topic)}</strong>
      <p>${escapeHtml(doc.summary || '')}</p>
      <span class="room-doc-meta">Uploaded by ${escapeHtml(doc.uploadedBy)}</span>
      ${doc.previewQuestion ? `<p class="room-doc-preview">First question preview: ${escapeHtml(doc.previewQuestion)}</p>` : ''}
    </div>
  `;
}

function renderGapDashboard(gapMaps) {
  if (!gapMaps.length) {
    gapDashboard.innerHTML = '<p class="room-empty">No gap maps yet. Start a gap hunt and your map shows up here.</p>';
    return;
  }

  gapDashboard.innerHTML = '';
  gapMaps.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'gap-dashboard-card';
    const score = entry.mastery?.score ?? '—';
    card.innerHTML = `
      <header class="gap-dashboard-header">
        ${avatarHtml(entry.name, 'room-avatar-gap', escapeHtml)}
        <strong>${escapeHtml(entry.name)}</strong>
        <span class="gap-dashboard-score">${score}%</span>
      </header>
      <p class="gap-dashboard-topic">${escapeHtml(entry.topic || 'No topic yet')}</p>
      <div class="gap-dashboard-graph"></div>
      <ul class="gap-dashboard-list"></ul>
    `;

    const graphEl = card.querySelector('.gap-dashboard-graph');
    const listEl = card.querySelector('.gap-dashboard-list');

    if (entry.gapMap?.length && entry.topic) {
      renderGapGraph(graphEl, entry.topic, entry.gapMap);
      listEl.innerHTML = entry.gapMap
        .map(
          (g) =>
            `<li class="gap-dashboard-item ${g.status}">
              <span class="gap-badge ${g.status}">${g.status === 'solid' ? 'Solid' : 'Shaky'}</span>
              ${escapeHtml(g.topic)}
            </li>`
        )
        .join('');
    } else {
      graphEl.innerHTML = '<p class="room-empty sm">Waiting for gap hunt…</p>';
    }

    gapDashboard.appendChild(card);
  });
}

function pinSnippet(m) {
  if (!m) return '';
  if (m.type === 'image') return 'Image';
  if (m.type === 'video') return 'Video';
  if (m.type === 'audio') return 'Voice note';
  if (m.type === 'file') return m.fileName || 'File';
  if (m.type === 'document') return m.topic || 'Document';
  return String(m.text || '').slice(0, 80);
}

function renderPin(pin) {
  const m = pin?.pinned;
  if (!m) {
    roomPin.classList.add('hidden');
    roomPin.innerHTML = '';
    delete roomPin.dataset.pinnedId;
    return;
  }
  roomPin.dataset.pinnedId = m.id;
  roomPin.classList.remove('hidden');
  roomPin.innerHTML = `<span class="room-pin-mark" aria-hidden="true">📌</span>
    <strong>${escapeHtml(m.name || 'Room')}</strong>
    <span>${escapeHtml(pinSnippet(m))}</span>
    <button type="button" class="room-pin-clear" data-unpin>Unpin</button>`;
}

function applyReact(msg) {
  if (!msg?.id) return;
  const body = roomChat.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"] .room-msg-body`);
  if (!body) return;
  const existing = body.querySelector('.room-msg-actions');
  const html = msgActionsHtml(msg);
  if (existing) existing.outerHTML = html;
  else body.insertAdjacentHTML('beforeend', html);
}

function noteTyping(name) {
  if (!name || name === myName) return;
  clearTimeout(typingNames.get(name));
  typingNames.set(name, setTimeout(() => {
    typingNames.delete(name);
    renderTyping();
  }, 2500));
  renderTyping();
}

function renderTyping() {
  const names = [...typingNames.keys()];
  if (!names.length) {
    roomTyping.classList.add('hidden');
    roomTyping.textContent = '';
    return;
  }
  roomTyping.classList.remove('hidden');
  roomTyping.textContent = names.length === 1
    ? `${names[0]} is explaining…`
    : `${names.join(', ')} are explaining…`;
}

function chosenMinutes() {
  const n = Math.round(Number(timerMins?.value));
  return Math.min(1440, Math.max(1, Number.isFinite(n) && n > 0 ? n : 25));
}

function formatCountdown(endsAt) {
  const left = Math.max(0, endsAt - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function applyTimer(timer) {
  activeTimer = timer && timer.endsAt > Date.now() ? timer : null;
  tickTimer();
}

function tickTimer() {
  const running = !!(activeTimer && activeTimer.endsAt > Date.now());
  if (!running) {
    activeTimer = null;
    timerBtn.textContent = `${chosenMinutes()}:00`;
    timerBtn.classList.remove('running');
    if (timerMins) timerMins.disabled = false;
    return;
  }
  timerBtn.textContent = formatCountdown(activeTimer.endsAt);
  timerBtn.classList.add('running');
  if (timerMins) timerMins.disabled = true;
}

let boardState = { presenterId: null, presenterName: null, elements: [], files: {} };
let boardRole = '';
let boardSceneTimer = 0;
let boardSceneGen = 0;
let boardApplyGen = 0;
let boardEmitSeq = 0;
let lastBoardSeq = -1;
let boardLastIds = '';
let boardHadEls = false;
const BOARD_THROTTLE_MS = 48;

function iAmPresenter() {
  return !!(mySocketId && boardState.presenterId === mySocketId);
}

function queueBoardScene(els, files) {
  const ids = liveElementIds(els);
  const flushNow = shouldFlushBoardScene(boardLastIds, ids);
  boardLastIds = ids;
  clearTimeout(boardSceneTimer);
  const gen = ++boardSceneGen;
  const send = async () => {
    if (!iAmPresenter() || gen !== boardSceneGen) return;
    const durable = await persistBoardFiles(files, uploadBoardImage);
    if (gen !== boardSceneGen) return;
    const scene = prepareBoardScene(els, durable, boardState.files);
    const seq = Math.max(boardEmitSeq, lastBoardSeq, 0) + 1;
    boardEmitSeq = seq;
    socket.emit('room:board', {
      action: 'scene',
      seq,
      elements: scene.elements,
      files: scene.files,
    });
  };
  if (flushNow) send();
  else boardSceneTimer = setTimeout(send, BOARD_THROTTLE_MS);
}

async function uploadBoardImage(dataUrl, mimeType) {
  const blob = await (await fetch(dataUrl)).blob();
  const ext = (mimeType || blob.type || 'image/png').split('/')[1] || 'png';
  const form = new FormData();
  form.append('memberToken', memberToken);
  form.append('board', '1');
  form.append('file', new File([blob], `board.${ext}`, { type: blob.type || mimeType || 'image/png' }));
  const res = await fetch(`/api/room/${activeRoomCodeValue}/attachment`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || 'Board image upload failed');
  return data.url;
}

function paintBoardChrome(board) {
  const mine = !!(mySocketId && board.presenterId === mySocketId);
  boardPresentBtn.textContent = mine ? 'Stop presenting' : board.presenterName ? 'Take over' : 'Present';
  boardPresentBtn.classList.toggle('in-call', mine);
  if (mine) boardStatus.textContent = 'You are presenting — others see this live.';
  else if (board.presenterName) boardStatus.textContent = `${board.presenterName} presenting — view only.`;
  else boardStatus.textContent = 'Present to draw. Everyone else follows live.';
}

async function applyBoard(board) {
  if (isRemoteBoardStale(lastBoardSeq, board?.seq)) return;
  const gen = ++boardApplyGen;
  const incoming = board || { presenterId: null, presenterName: null, elements: [], files: {}, seq: 0 };
  boardState = incoming;
  if (Number.isFinite(Number(incoming.seq))) lastBoardSeq = Number(incoming.seq);
  paintBoardChrome(incoming);

  if (!boardMount) return;
  try {
    await loadBoardLib();
  } catch (err) {
    boardStatus.textContent = `Board failed to load: ${err?.message || 'network'}.`;
    return;
  }

  try {
    const files = await resolveBoardFiles(incoming.files);
    if (!shouldCommitBoardApply({
      incomingSeq: incoming.seq,
      lastSeq: lastBoardSeq,
      applyGen: gen,
      currentGen: boardApplyGen,
    })) return;

    const mine = !!(mySocketId && incoming.presenterId === mySocketId);
    const role = mine ? 'present' : 'view';
    const n = liveElementCount(incoming.elements);
    if (boardMount) {
      boardMount.dataset.fileCount = String(Object.keys(incoming.files || {}).length);
      boardMount.dataset.elCount = String(n);
    }
    const remount = boardRole !== role;
    if (remount) {
      unmountBoard();
      boardRole = role;
      if (mine) {
        boardEmitSeq = Math.max(boardEmitSeq, lastBoardSeq);
        boardLastIds = liveElementIds(incoming.elements);
      }
      mountBoard(boardMount, {
        isPresenter: mine,
        elements: incoming.elements,
        files,
        onChange: (els, nextFiles) => queueBoardScene(els, nextFiles),
      });
      boardHadEls = n > 0;
      return;
    }
    boardHadEls = n > 0;
    if (!mine) applyBoardElements(incoming.elements, files);
  } catch (err) {
    boardStatus.textContent = `Board failed to render: ${err?.message || 'error'}.`;
  }
}

socket.on('room:board', (board) => applyBoard(board));

function requestBoardSync() {
  if (!joined || iAmPresenter()) return;
  socket.emit('room:board', { action: 'sync' });
}

setInterval(requestBoardSync, 8000);

window.addEventListener('room:e2e-board-scene', (ev) => {
  if (!iAmPresenter()) return;
  const seq = Math.max(boardEmitSeq, lastBoardSeq, 0) + 1;
  boardEmitSeq = seq;
  socket.emit('room:board', {
    action: 'scene',
    seq,
    elements: ev.detail?.elements || [],
    files: ev.detail?.files || {},
  });
});

function applyRoomExtras(state) {
  renderPin(state);
  applyTimer(state.timer);
  voiceCall.syncState(state.call || []);
  applyBoard(state.board);
}

function enterRoom(state, token, name) {
  joined = true;
  memberToken = token;
  myName = name;
  activeRoomCodeValue = state.code;
  voiceCall.reset();
  unmountBoard();
  boardRole = '';
  boardApplyGen = 0;
  lastBoardSeq = -1;
  boardEmitSeq = 0;
  boardLastIds = '';
  boardHadEls = false;
  joinPanel.classList.add('hidden');
  roomPanel.classList.remove('hidden');
  activeRoomCode.textContent = state.code;
  saveTabSession(state.code, token, name);
  localStorage.setItem('studyRoomCode', state.code);
  localStorage.setItem('studyRoomToken', token);
  localStorage.setItem('studyRoomName', name);

  history.replaceState(null, '', `/room/${state.code}`);
  renderPresence(state.presence);
  renderChat(state.messages);
  renderGapDashboard(state.gapMaps);
  renderRoomDocument(state.document);
  applyRoomExtras(state);
}

function attemptJoin(code, name) {
  showJoinError('');
  joinBtn.disabled = true;

  const emitJoin = () => {
    socket.emit('room:join', { roomCode: code, userName: name }, (reply) => {
      joinBtn.disabled = false;
      if (!reply) {
        showJoinError('No response from server. Try again.');
        return;
      }
      if (reply.error) {
        showJoinError(reply.error);
        return;
      }
      mySocketId = reply.socketId;
      enterRoom(reply.state, reply.memberToken, name);
    });
  };

  if (socket.connected) emitJoin();
  else socket.once('connect', emitJoin);
}

const presetCode = roomCodeFromPath();
if (presetCode) roomCodeInput.value = presetCode;
const tabSession = loadTabSession();
if (tabSession?.code === normalizeCode(presetCode) && tabSession.name) {
  displayNameInput.value = tabSession.name;
}

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  try {
    const res = await fetch('/api/room/create', { method: 'POST' });
    const { code } = await res.json();
    roomCodeInput.value = code;
    displayNameInput.value = '';
    history.replaceState(null, '', `/room/${code}`);
  } catch {
    showJoinError('Could not create room.');
  }
  createBtn.disabled = false;
});

joinBtn.addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  const name = displayNameInput.value.trim();
  if (!code || code.length < 4) {
    showJoinError('Enter a room code (4+ characters).');
    return;
  }
  if (!name) {
    showJoinError('Enter your name.');
    return;
  }
  attemptJoin(code, name);
});

copyCodeBtn.addEventListener('click', async () => {
  const code = activeRoomCode.textContent;
  try {
    await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
    copyCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyCodeBtn.textContent = 'Copy code'; }, 1500);
  } catch {
    copyCodeBtn.textContent = code;
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !joined) return;
  chatInput.value = '';
  socket.emit('room:chat', { text });
});

chatInput.addEventListener('input', () => {
  if (!joined) return;
  const now = Date.now();
  if (now - lastTypingAt < 800) return;
  lastTypingAt = now;
  socket.emit('room:typing');
});

roomChat.addEventListener('click', (e) => {
  const reactBtn = e.target.closest('[data-react]');
  const pinBtn = e.target.closest('[data-pin]');
  const msgEl = e.target.closest('[data-msg-id]');
  if (!joined || !msgEl) return;
  const messageId = msgEl.dataset.msgId;
  if (reactBtn) socket.emit('room:react', { messageId, emoji: reactBtn.dataset.react });
  if (pinBtn) socket.emit('room:pin', { messageId });
});

roomPin.addEventListener('click', (e) => {
  if (!joined || !e.target.closest('[data-unpin]')) return;
  const messageId = roomPin.dataset.pinnedId;
  if (messageId) socket.emit('room:pin', { messageId });
});

timerBtn.addEventListener('click', () => {
  if (!joined) return;
  if (activeTimer) socket.emit('room:timer', { action: 'stop' });
  else socket.emit('room:timer', { minutes: chosenMinutes() });
});

timerMins?.addEventListener('input', () => {
  if (!activeTimer) timerBtn.textContent = `${chosenMinutes()}:00`;
});

callBtn.addEventListener('click', () => {
  if (!joined) return;
  if (voiceCall.inCall) voiceCall.leave();
  else voiceCall.join();
});

callMuteBtn.addEventListener('click', () => voiceCall.toggleMute());
callCamBtn.addEventListener('click', () => voiceCall.toggleCam());

boardPresentBtn.addEventListener('click', () => {
  if (!joined) return;
  socket.emit('room:board', { action: iAmPresenter() ? 'release' : 'claim' });
});

setInterval(tickTimer, 1000);

function closeAttachMenu() {
  attachMenu.classList.add('hidden');
  attachBtn.setAttribute('aria-expanded', 'false');
}

attachBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  attachMenu.classList.toggle('hidden');
  const isOpen = !attachMenu.classList.contains('hidden');
  attachBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
});

attachMenu.addEventListener('click', (e) => e.stopPropagation());

attachMenu.querySelectorAll('.attach-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    closeAttachMenu();
    if (item.dataset.attach === 'image') imageInput.click();
    if (item.dataset.attach === 'video') videoInput.click();
    if (item.dataset.attach === 'file') fileInput.click();
  });
});

document.addEventListener('click', closeAttachMenu);

function bindAttachInput(input, expectedKind) {
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !joined) return;
    await uploadRoomAttachment(file, expectedKind);
  });
}

bindAttachInput(imageInput, 'image');
bindAttachInput(videoInput, 'video');
bindAttachInput(fileInput, 'file');

async function uploadRoomAttachment(file, expectedKind) {
  const kind = fileKind(file);
  if (expectedKind === 'image' && kind !== 'image') {
    showRoomStatus('Image only — pick a photo or screenshot.', 'error');
    return;
  }
  if (expectedKind === 'video' && kind !== 'video') {
    showRoomStatus('Video only — pick a video file.', 'error');
    return;
  }
  if (expectedKind === 'audio' && kind !== 'audio') {
    showRoomStatus('Audio only — send a voice note or audio file.', 'error');
    return;
  }
  const limit = ATTACH_LIMITS[kind];
  if (file.size > limit) {
    const cap = { image: '10MB', video: '50MB', audio: '10MB', file: '25MB' }[kind];
    showRoomStatus(`File too large — max ${cap}.`, 'error');
    return;
  }

  showRoomStatus(kind === 'image' ? 'Uploading image…' : kind === 'video' ? 'Uploading video…' : kind === 'audio' ? 'Uploading voice note…' : 'Uploading file…');
  const form = new FormData();
  form.append('memberToken', memberToken);
  form.append('file', file);

  try {
    const res = await fetch(`/api/room/${activeRoomCodeValue}/attachment`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    if (data.message) appendChatMessage(data.message);
    showRoomStatus('');
  } catch (err) {
    showRoomStatus(err.message, 'error');
  }
}
