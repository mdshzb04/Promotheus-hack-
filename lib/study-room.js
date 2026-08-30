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
      document: null,
    });
  }
  return rooms.get(normalized);
}

function joinMember(room, socketId, { name, sessionId = null, topic = null, gapMap = [], mastery = null }) {
  const memberToken = crypto.randomBytes(12).toString('hex');
  const member = {
    memberToken,
    socketId,
    name: String(name || 'Anonymous').slice(0, 32),
    sessionId,
    topic,
    gapMap,
    mastery,
    online: true,
    joinedAt: Date.now(),
  };
  room.members.set(memberToken, member);
  room.sockets.set(socketId, memberToken);
  return member;
}

function rejoinMember(room, socketId, memberToken, { name } = {}) {
  const member = room.members.get(memberToken);
  if (!member) return null;
  if (member.socketId && member.socketId !== socketId) {
    room.sockets.delete(member.socketId);
  }
  member.socketId = socketId;
  member.online = true;
  if (name) member.name = String(name).slice(0, 32);
  room.sockets.set(socketId, memberToken);
  return member;
}

function memberBySocket(room, socketId) {
  const token = room.sockets.get(socketId);
  return token ? room.members.get(token) : null;
}

function memberByToken(room, token) {
  return room.members.get(token) || null;
}

function disconnectSocket(room, socketId) {
  const token = room.sockets.get(socketId);
  if (!token) return null;
  const member = room.members.get(token);
  if (member) {
    member.online = false;
    member.socketId = null;
  }
  room.sockets.delete(socketId);
  return member;
}

function addMessage(room, msg) {
  const entry = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), ...msg };
  room.messages.push(entry);
  if (room.messages.length > 200) room.messages.shift();
  return entry;
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
  return {
    code: room.code,
    messages: room.messages,
    presence: presenceList(room),
    gapMaps: gapMapsView(room),
    document: room.document,
  };
}

module.exports = {
  generateCode,
  normalizeCode,
  getRoom,
  getOrCreateRoom,
  joinMember,
  rejoinMember,
  memberBySocket,
  memberByToken,
  disconnectSocket,
  addMessage,
  updateGapMapBySocket,
  updateGapMapByToken,
  setRoomDocument,
  presenceList,
  gapMapsView,
  publicRoomState,
  _rooms: rooms,
};
