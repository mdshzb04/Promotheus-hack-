const crypto = require('crypto');

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return rooms.has(code) ? generateCode() : code;
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getRoom(code) {
  const normalized = normalizeCode(code);
  return normalized ? rooms.get(normalized) || null : null;
}

function getOrCreateRoom(code) {
  const normalized = normalizeCode(code);
  if (!normalized || normalized.length < 4) return null;
  if (!rooms.has(normalized)) {
    rooms.set(normalized, {
      code: normalized,
      createdAt: Date.now(),
      messages: [],
      members: new Map(),
      sockets: new Map(),
      namesOnline: new Map(),
      document: null,
      pinnedId: null,
      timer: null,
    });
  }
  return rooms.get(normalized);
}

function normalizeMemberName(name) {
  return String(name || '').trim().slice(0, 32);
}

/** Atomically claim a display name for an online member (check + set, no yield). */
function claimOnlineName(room, name, memberToken, previousName = null) {
  if (!room.namesOnline) room.namesOnline = new Map();

  const displayName = normalizeMemberName(name);
  const key = displayName.toLowerCase();
  if (!key) return { error: 'Enter your name.' };

  const holder = room.namesOnline.get(key);
  if (holder && holder !== memberToken) {
    return { error: 'That name is already taken in this room — try another.' };
  }

  if (previousName) {
    const prevKey = normalizeMemberName(previousName).toLowerCase();
    if (prevKey !== key && room.namesOnline.get(prevKey) === memberToken) {
      room.namesOnline.delete(prevKey);
    }
  }

  room.namesOnline.set(key, memberToken);
  return { name: displayName };
}

function releaseOnlineName(room, memberToken, name) {
  if (!room.namesOnline || !name) return;
  const key = normalizeMemberName(name).toLowerCase();
  if (room.namesOnline.get(key) === memberToken) room.namesOnline.delete(key);
}

function isNameTakenByOnlineMember(room, name, excludeMemberToken = null) {
  if (!room.namesOnline) return false;
  const key = normalizeMemberName(name).toLowerCase();
  if (!key) return false;
  const holder = room.namesOnline.get(key);
  if (!holder) return false;
  if (excludeMemberToken && holder === excludeMemberToken) return false;
  return true;
}

function tryJoinMember(room, socketId, { name, sessionId = null, topic = null, gapMap = [], mastery = null }) {
  const memberToken = crypto.randomBytes(12).toString('hex');
  const claimed = claimOnlineName(room, name, memberToken);
  if (claimed.error) return claimed;

  const member = {
    memberToken,
    socketId,
    name: claimed.name,
    sessionId,
    topic,
    gapMap,
    mastery,
    online: true,
    joinedAt: Date.now(),
  };
  room.members.set(memberToken, member);
  room.sockets.set(socketId, memberToken);
  return { member };
}

function joinMember(room, socketId, opts) {
  const result = tryJoinMember(room, socketId, opts);
  if (result.error) throw new Error(result.error);
  return result.member;
}

function tryRejoinMember(room, socketId, memberToken, { name } = {}) {
  const member = room.members.get(memberToken);
  if (!member) return { error: 'Session expired. Join again.' };

  const nextName = name ? normalizeMemberName(name) : member.name;
  if (name && !nextName) return { error: 'Enter your name.' };

  const previousName = member.online ? member.name : null;
  const claimed = claimOnlineName(room, nextName, memberToken, previousName);
  if (claimed.error) return claimed;

  if (member.socketId && member.socketId !== socketId) {
    leaveCall(room, member.socketId);
    releaseBoard(room, member.socketId);
    room.sockets.delete(member.socketId);
  }
  member.socketId = socketId;
  member.online = true;
  member.name = claimed.name;
  room.sockets.set(socketId, memberToken);
  return { member };
}

function rejoinMember(room, socketId, memberToken, opts) {
  const result = tryRejoinMember(room, socketId, memberToken, opts);
  return result.member || null;
}

function memberBySocket(room, socketId) {
  const token = room.sockets.get(socketId);
  return token ? room.members.get(token) : null;
}

function memberByToken(room, token) {
  return room.members.get(token) || null;
}

function disconnectSocket(room, socketId) {
  leaveCall(room, socketId);
  releaseBoard(room, socketId);
  const token = room.sockets.get(socketId);
  if (!token) return null;
  const member = room.members.get(token);
  if (member) {
    member.online = false;
    member.socketId = null;
    releaseOnlineName(room, member.memberToken, member.name);
  }
  room.sockets.delete(socketId);
  return member;
}

function addMessage(room, msg) {
  const entry = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), reactions: {}, ...msg };
  if (!entry.reactions) entry.reactions = {};
  room.messages.push(entry);
  if (room.messages.length > 200) room.messages.shift();
  return entry;
}

function messageById(room, id) {
  return room.messages.find((m) => m.id === id) || null;
}

const REACTIONS = ['🔥', '❓', '✅'];

function toggleReaction(room, messageId, emoji, memberName) {
  if (!REACTIONS.includes(emoji)) return null;
  const msg = messageById(room, messageId);
  if (!msg) return null;
  if (!msg.reactions) msg.reactions = {};
  const names = msg.reactions[emoji] || [];
  const i = names.indexOf(memberName);
  if (i >= 0) names.splice(i, 1);
  else names.push(memberName);
  if (names.length) msg.reactions[emoji] = names;
  else delete msg.reactions[emoji];
  return msg;
}

function pinMessage(room, messageId) {
  const msg = messageById(room, messageId);
  if (!msg) return { pinnedId: null, pinned: null };
  room.pinnedId = room.pinnedId === messageId ? null : messageId;
  return {
    pinnedId: room.pinnedId,
    pinned: room.pinnedId ? messageById(room, room.pinnedId) : null,
  };
}

function startTimer(room, minutes, startedBy) {
  // ponytail: 24h ceiling; longer sessions belong on a calendar
  const raw = Math.round(Number(minutes));
  const mins = Number.isFinite(raw) ? Math.min(1440, Math.max(1, raw)) : 25;
  room.timer = { endsAt: Date.now() + mins * 60 * 1000, minutes: mins, startedBy: startedBy || 'Someone' };
  return room.timer;
}

function clearTimer(room) {
  room.timer = null;
  return null;
}

function publicTimer(room) {
  if (!room.timer || room.timer.endsAt <= Date.now()) {
    room.timer = null;
    return null;
  }
  return room.timer;
}

function callPeer(room, socketId) {
  const member = memberBySocket(room, socketId);
  if (!member) return null;
  return { socketId, name: member.name, camOn: !!(room.callCam && room.callCam.has(socketId)) };
}

function callPeers(room) {
  return [...(room.call || [])].map((id) => callPeer(room, id)).filter(Boolean);
}

function callHas(room, socketId) {
  return !!(room.call && room.call.has(socketId));
}

function joinCall(room, socketId) {
  if (!memberBySocket(room, socketId)) return callPeers(room);
  if (!room.call) room.call = new Set();
  if (!room.callCam) room.callCam = new Set();
  room.call.add(socketId);
  room.callCam.delete(socketId);
  return callPeers(room);
}

function leaveCall(room, socketId) {
  room.call?.delete(socketId);
  room.callCam?.delete(socketId);
  return callPeers(room);
}

function setCallCam(room, socketId, on) {
  if (!callHas(room, socketId)) return callPeers(room);
  if (!room.callCam) room.callCam = new Set();
  if (on) room.callCam.add(socketId);
  else room.callCam.delete(socketId);
  return callPeers(room);
}

function emptyBoard() {
  return { presenterId: null, presenterName: null, elements: [], files: {}, seq: 0, stamp: { n: 0, ver: 0 } };
}

function sceneStamp(elements) {
  let n = 0;
  let ver = 0;
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!el || el.isDeleted) continue;
    n += 1;
    ver += Number(el.version) || 0;
  }
  return { n, ver };
}

function isStaleBoardUpdate(board, seq) {
  const curSeq = Number(board?.seq) || 0;
  return seq != null && Number.isFinite(Number(seq)) && Number(seq) <= curSeq;
}

function dropBrokenImages(elements, files) {
  if (!Array.isArray(elements)) return [];
  return elements.filter((el) => {
    if (!el || el.type !== 'image' || el.isDeleted) return true;
    const file = files?.[el.fileId];
    return !!(file && isDurableBoardImage(file.dataURL));
  });
}

function pruneBrokenBoard(board) {
  if (!board) return;
  const files = board.files && typeof board.files === 'object' ? board.files : {};
  board.elements = dropBrokenImages(board.elements, files);
  board.stamp = sceneStamp(board.elements);
}

function publicBoard(room) {
  const b = room.board || emptyBoard();
  pruneBrokenBoard(room.board);
  return {
    presenterId: b.presenterId || null,
    presenterName: b.presenterName || null,
    elements: Array.isArray(b.elements) ? b.elements : [],
    files: b.files && typeof b.files === 'object' ? b.files : {},
    seq: Number(b.seq) || 0,
  };
}

function bumpBoardSeq(board) {
  board.seq = (Number(board.seq) || 0) + 1;
}

function claimBoard(room, socketId) {
  const member = memberBySocket(room, socketId);
  if (!member) return publicBoard(room);
  if (!room.board) room.board = emptyBoard();
  const prevPresenter = room.board.presenterId;
  if (prevPresenter && prevPresenter !== socketId) bumpBoardSeq(room.board);
  room.board.presenterId = socketId;
  room.board.presenterName = member.name;
  return publicBoard(room);
}

function isDurableBoardImage(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('data:image/') && url.length <= 2000000) return true;
  if (url.startsWith('/uploads/rooms/') && url.length < 300 && !url.includes('..') && !url.includes('\\')) return true;
  return false;
}

function sanitizeBoardFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return {};
  const out = {};
  let n = 0;
  for (const [rawId, file] of Object.entries(files)) {
    if (n >= 32) break;
    if (!file || !isDurableBoardImage(file.dataURL)) continue;
    const id = String(file.id || rawId).slice(0, 64);
    out[id] = {
      id,
      dataURL: file.dataURL,
      mimeType: String(file.mimeType || 'image/png').slice(0, 64),
      created: Number(file.created) || Date.now(),
    };
    n += 1;
  }
  return out;
}

function normalizeBoardElements(elements, files) {
  if (!Array.isArray(elements)) return [];
  return elements.slice(0, 2000).map((el) => {
    if (!el || typeof el !== 'object') return el;
    if (el.type === 'image' && el.fileId && files?.[el.fileId]) {
      return { ...el, status: 'saved' };
    }
    return el;
  });
}

function updateBoard(room, socketId, elements, files, seq) {
  if (!room.board || room.board.presenterId !== socketId) return null;
  pruneBrokenBoard(room.board);
  const incomingEls = Array.isArray(elements) ? elements.slice(0, 2000) : [];
  if (isStaleBoardUpdate(room.board, seq)) return publicBoard(room);

  const nextSeq = seq != null && Number.isFinite(Number(seq))
    ? Number(seq)
    : (Number(room.board.seq) || 0) + 1;

  const incoming = files !== undefined ? sanitizeBoardFiles(files) : {};
  const prev = room.board.files || {};
  const merged = { ...prev, ...incoming };
  const normalized = dropBrokenImages(normalizeBoardElements(incomingEls, merged), merged);

  room.board.elements = normalized;
  room.board.files = merged;
  room.board.seq = nextSeq;
  room.board.stamp = sceneStamp(normalized);
  return publicBoard(room);
}

function releaseBoard(room, socketId) {
  if (!room.board || room.board.presenterId !== socketId) return publicBoard(room);
  room.board.presenterId = null;
  room.board.presenterName = null;
  bumpBoardSeq(room.board);
  return publicBoard(room);
}

function applyGapMap(member, { topic, gapMap, mastery, sessionId }) {
  if (!member) return null;
  if (topic != null) member.topic = topic;
  if (gapMap != null) member.gapMap = gapMap;
  if (mastery != null) member.mastery = mastery;
  if (sessionId != null) member.sessionId = sessionId;
  return member;
}

function updateGapMapBySocket(room, socketId, payload) {
  return applyGapMap(memberBySocket(room, socketId), payload);
}

function updateGapMapByToken(room, memberToken, payload) {
  return applyGapMap(room.members.get(memberToken), payload);
}

function presenceList(room) {
  return [...room.members.values()]
    .filter((m) => m.online)
    .map((m) => ({
      socketId: m.socketId,
      name: m.name,
      topic: m.topic,
      masteryScore: m.mastery?.score ?? null,
      hasGapMap: (m.gapMap?.length ?? 0) > 0,
      inCall: callHas(room, m.socketId),
    }));
}

function gapMapsView(room) {
  return [...room.members.values()]
    .filter((m) => m.online || (m.gapMap?.length ?? 0) > 0)
    .map((m) => ({
      socketId: m.socketId,
      name: m.name,
      topic: m.topic,
      gapMap: m.gapMap || [],
      mastery: m.mastery,
    }));
}

function setRoomDocument(room, doc) {
  room.document = {
    topic: doc.topic,
    summary: doc.summary || '',
    previewQuestion: doc.previewQuestion || '',
    keyConcepts: doc.keyConcepts || [],
    uploadedBy: doc.uploadedBy || 'Someone',
    at: Date.now(),
  };
  return room.document;
}

function publicRoomState(room) {
  const pinnedId = room.pinnedId || null;
  return {
    code: room.code,
    messages: room.messages,
    presence: presenceList(room),
    gapMaps: gapMapsView(room),
    document: room.document,
    pinnedId,
    pinned: pinnedId ? messageById(room, pinnedId) : null,
    timer: publicTimer(room),
    call: callPeers(room),
    board: publicBoard(room),
  };
}

module.exports = {
  generateCode,
  normalizeCode,
  getRoom,
  getOrCreateRoom,
  joinMember,
  tryJoinMember,
  tryRejoinMember,
  rejoinMember,
  memberBySocket,
  memberByToken,
  disconnectSocket,
  addMessage,
  messageById,
  toggleReaction,
  pinMessage,
  startTimer,
  clearTimer,
  joinCall,
  leaveCall,
  setCallCam,
  callPeers,
  callHas,
  claimBoard,
  updateBoard,
  releaseBoard,
  publicBoard,
  updateGapMapBySocket,
  updateGapMapByToken,
  setRoomDocument,
  presenceList,
  gapMapsView,
  publicRoomState,
  normalizeMemberName,
  isNameTakenByOnlineMember,
  _rooms: rooms,
};
