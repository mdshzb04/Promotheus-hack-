require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { Server } = require('socket.io');
const {
  askGapQuestion,
  extractFromNotes,
  extractFromDocument,
  generateSessionReport,
  gradeProveIt,
  buildTranscript,
  getProvider,
} = require('./lib/ai');
const sessionStore = require('./lib/session');
const gapHistory = require('./lib/gap-history');
const studyRoom = require('./lib/study-room');
const pdfIngest = require('./lib/pdf-ingest');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'uploads', 'rooms');
const PDF_UPLOAD_DIR = path.join(__dirname, 'uploads', 'pdfs');

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(PDF_UPLOAD_DIR, { recursive: true });
      cb(null, PDF_UPLOAD_DIR);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${crypto.randomBytes(16).toString('hex')}.pdf`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    cb(isPdf ? null : new Error('PDF only — upload a .pdf file.'), isPdf);
  },
});

function imageExt(mime = '', originalname = '') {
  const fromName = path.extname(originalname).slice(1).toLowerCase();
  if (fromName === 'jpeg') return 'jpg';
  if (['png', 'jpg', 'gif', 'webp'].includes(fromName)) return fromName;
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

function videoExt(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogv';
  if (mime.includes('quicktime')) return 'mov';
  return 'mp4';
}

function safeExt(originalname = '', fallback = 'bin') {
  const ext = path.extname(originalname).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext.slice(0, 8) || fallback;
}

const ATTACH_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  file: 25 * 1024 * 1024,
};

function audioExt(mime = '', originalname = '') {
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  return safeExt(originalname, 'webm');
}

function roomAttachKind(mime = '', originalname = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const name = String(originalname || '');
  if ((!mime || mime === 'application/octet-stream') && /\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return 'file';
}

function boardAttachKind(file) {
  const mime = file?.mimetype || '';
  const name = String(file?.originalname || '');
  if (mime.startsWith('image/')) return 'image';
  if (!mime || mime === 'application/octet-stream') return 'image';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return roomAttachKind(mime, name);
}

function roomAttachmentUrl(roomCode, filename) {
  return `/uploads/rooms/${studyRoom.normalizeCode(roomCode)}/${filename}`;
}

const roomAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOAD_ROOT, studyRoom.normalizeCode(req.params.roomCode));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const isBoard = String(req.body?.board || '') === '1';
      const kind = isBoard ? boardAttachKind(file) : roomAttachKind(file.mimetype, file.originalname);
      const ext =
        kind === 'image'
          ? imageExt(file.mimetype, file.originalname)
          : kind === 'video'
            ? videoExt(file.mimetype)
            : kind === 'audio'
              ? audioExt(file.mimetype, file.originalname)
              : safeExt(file.originalname);
      cb(null, `${crypto.randomBytes(8).toString('hex')}.${ext}`);
    },
  }),
  limits: { fileSize: ATTACH_LIMITS.video },
});

function handleRoomAttachment(req, res) {
  const room = studyRoom.getRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  roomAttachmentUpload.single('file')(req, res, (uploadErr) => {
    if (uploadErr instanceof multer.MulterError) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large — max 50MB video, 25MB files, 10MB images or audio.' });
      }
      return res.status(400).json({ error: uploadErr.message });
    }
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const member = studyRoom.memberByToken(room, req.body?.memberToken);
    if (!member) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Not in this room.' });
    }

    const isBoard = String(req.body?.board || '') === '1';
    const kind = isBoard ? boardAttachKind(req.file) : roomAttachKind(req.file.mimetype, req.file.originalname);
    if (req.file.size > ATTACH_LIMITS[kind]) {
      fs.unlink(req.file.path, () => {});
      const cap = { image: '10MB', video: '50MB', audio: '10MB', file: '25MB' }[kind];
      return res.status(400).json({ error: `File too large — max ${cap}.` });
    }

    const url = roomAttachmentUrl(room.code, req.file.filename);
    if (isBoard) {
      if (kind !== 'image') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Board files must be images.' });
      }
      return res.json({ ok: true, url });
    }
    let msg;
    if (kind === 'image') {
      msg = studyRoom.addMessage(room, { type: 'image', name: member.name, imageUrl: url });
    } else if (kind === 'video') {
      msg = studyRoom.addMessage(room, { type: 'video', name: member.name, videoUrl: url });
    } else if (kind === 'audio') {
      msg = studyRoom.addMessage(room, { type: 'audio', name: member.name, audioUrl: url });
    } else {
      msg = studyRoom.addMessage(room, {
        type: 'file',
        name: member.name,
        fileUrl: url,
        fileName: String(req.file.originalname || 'file').slice(0, 180),
        fileSize: req.file.size,
      });
    }
    io.to(roomChannel(room.code)).emit('room:message', msg);
    res.json({ ok: true, message: msg });
  });
}

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function isClientPdfError(message = '') {
  return (
    message.includes('scanned') ||
    message.includes('corrupt') ||
    message.includes('PDF only') ||
    message.includes('selectable text') ||
    message.includes('does not look like') ||
    message.includes('empty')
  );
}

function handlePdfUpload(req, res, handler) {
  pdfUpload.single('pdf')(req, res, async (uploadErr) => {
    if (uploadErr instanceof multer.MulterError) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large — max 50MB' });
      }
      return res.status(400).json({ error: uploadErr.message });
    }
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const filePath = req.file.path;
    try {
      const payload = await handler(null, filePath);
      res.json(payload);
    } catch (err) {
      console.error(err);
      const status = err instanceof ClientError ? err.status : isClientPdfError(err.message) ? 400 : 500;
      res.status(status).json({ error: err.message || 'Failed to extract PDF.' });
    } finally {
      pdfIngest.deletePdf(filePath);
    }
  });
}

app.use(express.json({ limit: '128kb' }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hero.html'));
});

app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

function analysisPayload(a) {
  return {
    gap_detected: a.gap_detected,
    gap_type: a.gap_type,
    gap_topic: a.gap_topic,
    severity: a.severity,
    weak_phrase: a.weak_phrase || '',
  };
}

function roomChannel(code) {
  return `room:${studyRoom.normalizeCode(code)}`;
}

function broadcastGapMaps(room) {
  io.to(roomChannel(room.code)).emit('room:gap-maps', studyRoom.gapMapsView(room));
}

app.get('/room/:roomCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/room', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.post('/api/room/create', (_req, res) => {
  const code = studyRoom.generateCode();
  studyRoom.getOrCreateRoom(code);
  res.json({ code });
});

app.post('/api/room/:roomCode/gap-sync', (req, res) => {
  const room = studyRoom.getRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { memberToken, topic, gapMap, mastery, sessionId } = req.body || {};
  const member = studyRoom.memberByToken(room, memberToken);
  if (!member) return res.status(403).json({ error: 'Not in this room.' });

  studyRoom.updateGapMapByToken(room, memberToken, { topic, gapMap, mastery, sessionId });
  broadcastGapMaps(room);

  if (req.body?.announce) {
    const score = mastery?.score != null ? ` (${mastery.score}%)` : '';
    const note = studyRoom.addMessage(room, {
      type: 'chat',
      name: member.name,
      text: `Posted gap map: ${String(topic || 'Untitled').slice(0, 80)}${score}`,
    });
    io.to(roomChannel(room.code)).emit('room:message', note);
  }

  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: getProvider() || 'none',
    adaptive: true,
    maxQuestions: sessionStore.MAX_QUESTIONS,
  });
});

app.get('/api/insights', (_req, res) => {
  res.json(gapHistory.computeInsights());
});

app.get('/api/session/:id', (req, res) => {
  const session = sessionStore.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
  res.json({ session: sessionStore.publicView(session) });
});

app.get('/api/session/:id/report', (req, res) => {
  const session = sessionStore.getSession(req.params.id);
  if (!session?.complete) return res.status(404).json({ error: 'Report not ready.' });
  res.json({
    markdown: sessionStore.buildMarkdownReport(session),
    session: sessionStore.publicView(session),
  });
});

app.post('/api/extract-notes', async (req, res) => {
  try {
    const { notes } = req.body || {};
    if (!notes?.trim() || notes.trim().length < 40) {
      return res.status(400).json({ error: 'Paste at least a paragraph of notes (40+ chars).' });
    }
    const extracted = await extractFromNotes(notes.trim());
    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to extract topic.' });
  }
});

app.post('/api/extract-pdf', (req, res) => {
  handlePdfUpload(req, res, async (_member, filePath) => {
    const { text, charCount, truncated } = await pdfIngest.extractTextFromPdf(filePath);
    const extracted = await extractFromDocument(text);
    return { ...extracted, charCount, truncated };
  });
});

app.post('/api/room/:roomCode/extract-pdf', (req, res) => {
  handlePdfUpload(req, res, async (_member, filePath) => {
    const room = studyRoom.getRoom(req.params.roomCode);
    if (!room) throw new ClientError('Room not found.', 404);

    const memberToken = req.body?.memberToken;
    const member = studyRoom.memberByToken(room, memberToken);
    if (!member) throw new ClientError('Not in this room.', 403);

    const { text, charCount, truncated } = await pdfIngest.extractTextFromPdf(filePath);
    const extracted = await extractFromDocument(text);
    studyRoom.setRoomDocument(room, { ...extracted, uploadedBy: member.name });

    const docMsg = studyRoom.addMessage(room, {
      type: 'document',
      name: member.name,
      topic: extracted.topic,
      summary: extracted.summary,
      previewQuestion: extracted.previewQuestion,
    });
    io.to(roomChannel(room.code)).emit('room:message', docMsg);
    io.to(roomChannel(room.code)).emit('room:document', room.document);

    return { ok: true, message: docMsg, ...extracted, charCount, truncated };
  });
});

app.post('/api/room/:roomCode/attachment', handleRoomAttachment);

app.post('/api/start', async (req, res) => {
  try {
    const { topic, explanation, fromNotes } = req.body || {};
    if (!topic?.trim() || !explanation?.trim()) {
      return res.status(400).json({ error: 'Topic and explanation are required.' });
    }
    if (explanation.trim().length < 20) {
      return res.status(400).json({ error: 'Write at least 2-4 sentences (20+ chars).' });
    }

    const session = sessionStore.createSession(topic, explanation, { fromNotes: !!fromNotes });
    const analysis = await askGapQuestion(session, { mode: 'explore' });
    sessionStore.recordAnalysis(session, analysis);
    session.lastRouting = { mode: 'explore' };

    res.json({
      session: sessionStore.publicView(session),
      question: analysis.question,
      analysis: analysisPayload(analysis),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to start session.' });
  }
});

app.post('/api/answer', async (req, res) => {
  try {
    const { sessionId, answer } = req.body || {};
    if (!sessionId || !answer?.trim()) {
      return res.status(400).json({ error: 'sessionId and answer are required.' });
    }

    const session = sessionStore.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
    if (session.complete) return res.status(400).json({ error: 'Session already complete.' });
    if (!session.rounds.at(-1).question) {
      return res.status(400).json({ error: 'No pending question for this round.' });
    }

    sessionStore.recordAnswer(session, answer);
    const { complete, routing } = sessionStore.planNextStep(session);

    if (complete) {
      const shakyGaps = sessionStore
        .buildGapMap(session)
        .filter((g) => g.status === 'shaky')
        .map((g) => ({
          gap_topic: g.topic,
          gap_type: g.gap_type,
          question: g.question,
        }));

      const report = await generateSessionReport(
        session.topic,
        shakyGaps,
        buildTranscript(session)
      );
      sessionStore.finalizeSession(session, report);
      gapHistory.appendSession(session);

      return res.json({
        complete: true,
        session: sessionStore.publicView(session),
      });
    }

    sessionStore.applyRoutingState(session, routing);
    session.lastRouting = routing;
    sessionStore.startNextRound(session, answer);
    const analysis = await askGapQuestion(session, routing);
    sessionStore.recordAnalysis(session, analysis);

    res.json({
      complete: false,
      routing,
      question: analysis.question,
      analysis: analysisPayload(analysis),
      session: sessionStore.publicView(session),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to process answer.' });
  }
});

app.post('/api/prove-it', async (req, res) => {
  try {
    const { sessionId, explanation } = req.body || {};
    if (!sessionId || !explanation?.trim()) {
      return res.status(400).json({ error: 'sessionId and explanation are required.' });
    }

    const session = sessionStore.getSession(sessionId);
    if (!session?.complete) return res.status(400).json({ error: 'Complete a session first.' });
    if (!session.proveIt) {
      return res.json({ skipped: true, session: sessionStore.publicView(session) });
    }
    if (session.proveItResult) {
      return res.json({ session: sessionStore.publicView(session) });
    }

    const result = await gradeProveIt(
      session.topic,
      session.proveIt.topic,
      session.proveIt.gap_type,
      explanation.trim()
    );
    sessionStore.applyProveIt(session, result);

    res.json({ result, session: sessionStore.publicView(session) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Prove-it grading failed.' });
  }
});

const socketRooms = new Map();

function emitCallState(room) {
  io.to(roomChannel(room.code)).emit('room:call', { action: 'state', peers: studyRoom.callPeers(room) });
  io.to(roomChannel(room.code)).emit('room:presence', studyRoom.presenceList(room));
}

function attachMember(room, socket, member) {
  socket.join(roomChannel(room.code));
  socketRooms.set(socket.id, room.code);
  io.to(roomChannel(room.code)).emit('room:presence', studyRoom.presenceList(room));
  return member;
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomCode, userName }, ack) => {
    const room = studyRoom.getOrCreateRoom(roomCode);
    if (!room) return ack?.({ error: 'Invalid room code.' });

    const result = studyRoom.tryJoinMember(room, socket.id, { name: userName });
    if (result.error) return ack?.({ error: result.error });
    const member = result.member;

    attachMember(room, socket, member);

    const joined = studyRoom.addMessage(room, {
      type: 'system',
      text: `${member.name} joined`,
    });
    io.to(roomChannel(room.code)).emit('room:message', joined);

    ack?.({
      socketId: socket.id,
      memberToken: member.memberToken,
      state: studyRoom.publicRoomState(room),
    });
  });

  socket.on('room:rejoin', ({ roomCode, memberToken, userName }, ack) => {
    const room = studyRoom.getRoom(roomCode);
    if (!room) return ack?.({ error: 'Room not found.' });

    const result = studyRoom.tryRejoinMember(room, socket.id, memberToken, { name: userName });
    if (result.error) return ack?.({ error: result.error });
    const member = result.member;

    attachMember(room, socket, member);

    ack?.({
      socketId: socket.id,
      memberToken: member.memberToken,
      state: studyRoom.publicRoomState(room),
    });
  });

  socket.on('room:chat', ({ text }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member || !text?.trim()) return;

    const msg = studyRoom.addMessage(room, {
      type: 'chat',
      name: member.name,
      text: text.trim().slice(0, 2000),
    });
    io.to(roomChannel(room.code)).emit('room:message', msg);
  });

  socket.on('room:gap-sync', ({ topic, gapMap, mastery, sessionId }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    if (!room) return;
    studyRoom.updateGapMapBySocket(room, socket.id, { topic, gapMap, mastery, sessionId });
    broadcastGapMaps(room);
  });

  socket.on('room:typing', () => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member) return;
    socket.to(roomChannel(room.code)).emit('room:typing', { name: member.name });
  });

  socket.on('room:react', ({ messageId, emoji }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member || !messageId) return;
    const msg = studyRoom.toggleReaction(room, messageId, emoji, member.name);
    if (msg) io.to(roomChannel(room.code)).emit('room:react', msg);
  });

  socket.on('room:pin', ({ messageId }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member || !messageId) return;
    const pin = studyRoom.pinMessage(room, messageId);
    io.to(roomChannel(room.code)).emit('room:pin', pin);
  });

  socket.on('room:timer', ({ action, minutes } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member) return;
    const timer = action === 'stop' ? studyRoom.clearTimer(room) : studyRoom.startTimer(room, minutes || 25, member.name);
    io.to(roomChannel(room.code)).emit('room:timer', timer);
  });

  socket.on('room:call', ({ action, to, data, on } = {}, ack) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member) return ack?.({ error: 'Not in a room.' });

    if (action === 'join') {
      const peers = studyRoom.joinCall(room, socket.id);
      emitCallState(room);
      return ack?.({ ok: true, peers });
    }
    if (action === 'leave') {
      studyRoom.leaveCall(room, socket.id);
      emitCallState(room);
      return ack?.({ ok: true, peers: studyRoom.callPeers(room) });
    }
    if (action === 'cam') {
      if (!studyRoom.callHas(room, socket.id)) return ack?.({ error: 'Not in a call.' });
      const peers = studyRoom.setCallCam(room, socket.id, !!on);
      emitCallState(room);
      return ack?.({ ok: true, peers });
    }
    if (action === 'signal' && to && data) {
      if (!studyRoom.callHas(room, socket.id) || !studyRoom.callHas(room, to)) return;
      io.to(to).emit('room:call', { action: 'signal', from: socket.id, data });
    }
  });

  socket.on('room:board', ({ action, elements, files, seq } = {}, ack) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member) return ack?.({ error: 'Not in a room.' });

    let board = null;
    if (action === 'claim') board = studyRoom.claimBoard(room, socket.id);
    else if (action === 'release') board = studyRoom.releaseBoard(room, socket.id);
    else if (action === 'sync') {
      socket.emit('room:board', studyRoom.publicBoard(room));
      return ack?.({ ok: true, board: studyRoom.publicBoard(room) });
    } else if (action === 'scene') {
      const prevSeq = studyRoom.publicBoard(room).seq || 0;
      board = studyRoom.updateBoard(room, socket.id, elements, files, seq);
      if (board && (board.seq || 0) === prevSeq && prevSeq > 0) {
        return ack?.({ ok: true, board, stale: true });
      }
    }
    if (!board) return ack?.({ error: 'Only the presenter can draw.' });

    io.to(roomChannel(room.code)).emit('room:board', board);
    ack?.({ ok: true, board });
  });

  socket.on('disconnect', () => {
    const code = socketRooms.get(socket.id);
    socketRooms.delete(socket.id);
    if (!code) return;

    const room = studyRoom.getRoom(code);
    if (!room) return;

    const member = studyRoom.disconnectSocket(room, socket.id);

    if (studyRoom.getRoom(code)) {
      const left = studyRoom.addMessage(room, {
        type: 'system',
        text: `${member?.name || 'Someone'} left`,
      });
      io.to(roomChannel(code)).emit('room:message', left);
      io.to(roomChannel(code)).emit('room:presence', studyRoom.presenceList(room));
      io.to(roomChannel(code)).emit('room:gap-maps', studyRoom.gapMapsView(room));
      io.to(roomChannel(code)).emit('room:call', { action: 'state', peers: studyRoom.callPeers(room) });
      io.to(roomChannel(code)).emit('room:board', studyRoom.publicBoard(room));
    }
  });
});

server.listen(PORT, () => {
  const provider = getProvider();
  console.log(`Feynman Gap Finder → http://localhost:${PORT}`);
  if (!provider) {
    console.warn('No API key found. Copy .env.example → .env and add OPENAI_API_KEY or ANTHROPIC_API_KEY');
  } else {
    console.log(`AI provider: ${provider} · adaptive routing on`);
  }
});
