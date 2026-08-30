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
const io = new Server(server);
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

function saveRoomImage(roomCode, { mime, data }) {
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new Error('Image too large (max 5MB)');
  const ext = mime?.includes('png') ? 'png' : mime?.includes('gif') ? 'gif' : mime?.includes('webp') ? 'webp' : 'jpg';
  const dir = path.join(UPLOAD_ROOT, studyRoom.normalizeCode(roomCode));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return `/uploads/rooms/${studyRoom.normalizeCode(roomCode)}/${filename}`;
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

    return { ok: true, ...extracted, charCount, truncated };
  });
});

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

    const member = studyRoom.joinMember(room, socket.id, { name: userName });
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

    const member = studyRoom.rejoinMember(room, socket.id, memberToken, { name: userName });
    if (!member) return ack?.({ error: 'Session expired. Join again.' });

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

  socket.on('room:image', ({ mime, data }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    const member = room ? studyRoom.memberBySocket(room, socket.id) : null;
    if (!room || !member || !data) return;

    try {
      const imageUrl = saveRoomImage(room.code, { mime, data });
      const msg = studyRoom.addMessage(room, {
        type: 'image',
        name: member.name,
        imageUrl,
      });
      io.to(roomChannel(room.code)).emit('room:message', msg);
    } catch (err) {
      socket.emit('room:error', err.message || 'Image upload failed.');
    }
  });

  socket.on('room:gap-sync', ({ topic, gapMap, mastery, sessionId }) => {
    const code = socketRooms.get(socket.id);
    const room = code ? studyRoom.getRoom(code) : null;
    if (!room) return;
    studyRoom.updateGapMapBySocket(room, socket.id, { topic, gapMap, mastery, sessionId });
    broadcastGapMaps(room);
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
