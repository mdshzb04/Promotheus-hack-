import { renderGapGraph } from '/gap-graph.js';

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
const pdfInput = $('#pdf-input');
const attachBtn = $('#attach-btn');
const attachMenu = $('#attach-menu');
const uploadStatus = $('#room-upload-status');
const roomDocument = $('#room-document');
const gapDashboard = $('#gap-dashboard');

const socket = io();
let joined = false;
let mySocketId = null;
let memberToken = null;
let activeRoomCodeValue = '';

socket.on('room:presence', (presence) => renderPresence(presence));
socket.on('room:message', (msg) => appendChatMessage(msg));
socket.on('room:gap-maps', (gapMaps) => renderGapDashboard(gapMaps));
socket.on('room:document', (doc) => renderRoomDocument(doc));
socket.on('room:error', (msg) => showRoomStatus(msg, 'error'));

socket.on('connect', () => {
  if (joined) return;
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

function renderPresence(presence) {
  presenceList.innerHTML = presence
    .map((p) => {
      const score = p.masteryScore != null ? `${p.masteryScore}%` : '—';
      const you = p.socketId === mySocketId;
      return `<li class="presence-item${you ? ' you' : ''}">
        <span class="presence-dot" aria-hidden="true"></span>
        <span class="presence-name">${escapeHtml(p.name)}${you ? ' (you)' : ''}</span>
        <span class="presence-score">${score}</span>
      </li>`;
    })
    .join('');
}

function documentMsgHtml(m) {
  return `<div class="room-msg document">
    <span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
    <div class="room-doc-card">
      <span class="room-doc-label">Shared document</span>
      <strong>${escapeHtml(m.topic)}</strong>
      <p>${escapeHtml(m.summary || '')}</p>
      ${m.previewQuestion ? `<p class="room-doc-preview">Preview: ${escapeHtml(m.previewQuestion)}</p>` : ''}
    </div>
  </div>`;
}

function renderChat(messages) {
  roomChat.innerHTML = messages
    .map((m) => {
      if (m.type === 'image') {
        return `<div class="room-msg">
          <span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
          <img class="room-msg-image" src="${escapeHtml(m.imageUrl)}" alt="Shared by ${escapeHtml(m.name)}" loading="lazy" />
        </div>`;
      }
      if (m.type === 'document') return documentMsgHtml(m);
      if (m.type === 'system') {
        return `<div class="room-msg system">${escapeHtml(m.text)}</div>`;
      }
      return `<div class="room-msg">
        <span class="room-msg-meta">${escapeHtml(m.name)} · ${formatTime(m.at)}</span>
        <p class="room-msg-text">${escapeHtml(m.text)}</p>
      </div>`;
    })
    .join('');
  roomChat.scrollTop = roomChat.scrollHeight;
}

function appendChatMessage(msg) {
  const wrap = document.createElement('div');
  if (msg.type === 'image') {
    wrap.className = 'room-msg';
    wrap.innerHTML = `
      <span class="room-msg-meta">${escapeHtml(msg.name)} · ${formatTime(msg.at)}</span>
      <img class="room-msg-image" src="${escapeHtml(msg.imageUrl)}" alt="Shared by ${escapeHtml(msg.name)}" loading="lazy" />
    `;
  } else if (msg.type === 'document') {
    wrap.innerHTML = documentMsgHtml(msg);
  } else if (msg.type === 'system') {
    wrap.className = 'room-msg system';
    wrap.textContent = msg.text;
  } else {
    wrap.className = 'room-msg';
    wrap.innerHTML = `
      <span class="room-msg-meta">${escapeHtml(msg.name)} · ${formatTime(msg.at)}</span>
      <p class="room-msg-text">${escapeHtml(msg.text)}</p>
    `;
  }
  roomChat.appendChild(wrap);
  roomChat.scrollTop = roomChat.scrollHeight;
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

function enterRoom(state, token, name) {
  joined = true;
  memberToken = token;
  activeRoomCodeValue = state.code;
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
    if (item.dataset.attach === 'pdf') pdfInput.click();
  });
});

document.addEventListener('click', closeAttachMenu);

imageInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !joined) return;
  if (file.size > 5 * 1024 * 1024) {
    showRoomStatus('Image must be under 5MB.', 'error');
    return;
  }
  showRoomStatus('Uploading image…');
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  socket.emit('room:image', { name: file.name, mime: file.type, data: btoa(binary) });
  showRoomStatus('');
});

pdfInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !joined) return;
  await uploadRoomPdf(file);
});

async function uploadRoomPdf(file) {
  if (file.size > 50 * 1024 * 1024) {
    showRoomStatus('File too large — max 50MB', 'error');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    showRoomStatus('PDF only — upload a .pdf file.', 'error');
    return;
  }

  showRoomStatus('Extracting text…');
  const analyzeTimer = setTimeout(() => showRoomStatus('Analyzing document…'), 900);

  const form = new FormData();
  form.append('pdf', file);
  form.append('memberToken', memberToken);

  try {
    const res = await fetch(`/api/room/${activeRoomCodeValue}/extract-pdf`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PDF extraction failed');
    showRoomStatus('');
  } catch (err) {
    showRoomStatus(err.message, 'error');
  } finally {
    clearTimeout(analyzeTimer);
  }
}
