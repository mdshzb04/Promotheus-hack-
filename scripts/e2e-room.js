const http = require('http');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3099;
process.env.PORT = PORT;

require('../server.js');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${url}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function connectClient() {
  return new Promise((resolve) => {
    const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

function joinRoom(socket, roomCode, userName) {
  return new Promise((resolve) => {
    socket.emit('room:join', { roomCode, userName }, resolve);
  });
}

async function main() {
  await wait(400);

  const css = await get('/room.css');
  const styles = await get('/styles.css');
  const js = await get('/room.js');
  const voiceJs = await get('/room-voice.js');
  const boardJs = await get('/room-board.js');
  const roomPage = await get('/room/TESTXY');

  assert(css.headers['content-type']?.includes('text/css'), 'room.css content-type');
  assert(css.body.includes('.room-app'), 'room.css has styles');
  assert(css.body.includes('.room-avatar-presence'), 'room.css has avatar styles');
  assert(styles.status === 200, 'styles.css 200');
  assert(js.status === 200 && js.body.includes('room:join'), 'room.js loads');
  assert(voiceJs.status === 200 && voiceJs.body.includes('room:call'), 'room-voice.js handles call signaling');
  assert(boardJs.status === 200 && boardJs.body.includes('Excalidraw'), 'room-board.js loads Excalidraw');
  assert(js.body.includes('room-avatar-chat'), 'room.js renders chat avatars');
  assert(js.body.includes('/attachment'), 'room.js uses attachment upload');
  assert(roomPage.body.includes('image-input'), 'room.html has image picker');
  assert(roomPage.body.includes('video-input'), 'room.html has video picker');
  assert(roomPage.body.includes('file-input'), 'room.html has file picker');
  assert(roomPage.body.includes('data-attach="image"'), 'attach menu has Image');
  assert(roomPage.body.includes('data-attach="video"'), 'attach menu has Video');
  assert(roomPage.body.includes('data-attach="file"'), 'attach menu has File');
  assert(css.body.includes('.room-msg-video'), 'room.css has video styles');
  assert(js.body.includes('column-reverse'), 'room.js documents column-reverse chat');
  assert(roomPage.body.includes('id="timer-btn"'), 'room.html has timer');
  assert(roomPage.body.includes('id="timer-mins"'), 'room.html has timer minutes input');
  assert(roomPage.body.includes('id="call-btn"'), 'room.html has voice call button');
  assert(roomPage.body.includes('id="call-cam-btn"'), 'room.html has camera toggle');
  assert(roomPage.body.includes('id="call-stage"'), 'room.html has call stage');
  assert(roomPage.body.includes('id="board-mount"'), 'room.html has board');
  assert(roomPage.body.includes('id="board-present-btn"'), 'room.html has present button');
  assert(css.body.includes('.room-board-mount'), 'room.css has board styles');
  assert(css.body.includes('minmax(0, 7fr)'), 'board column dominates room grid');
  assert(!roomPage.body.includes('id="voice-note-btn"'), 'chat has no voice-note mic');
  assert(css.body.includes('.room-call-btn'), 'room.css has call styles');
  assert(css.body.includes('.room-msg-audio'), 'room.css has audio message styles');
  assert(roomPage.body.includes('id="room-pin"'), 'room.html has pin bar');
  assert(roomPage.body.includes('id="room-typing"'), 'room.html has typing line');
  assert(js.body.includes('room:typing'), 'room.js emits typing');
  assert(js.body.includes('data-react'), 'room.js renders reactions');
  assert(css.body.includes('.room-timer-btn'), 'room.css has timer styles');

  const appPage = await get('/app');
  const appJs = await get('/app.js');
  assert(appPage.body.includes('id="post-room-btn"'), 'app has post-to-room button');
  assert(appJs.body.includes('announce'), 'app can announce gap map');

  function attachmentForm(token, blob, filename) {
    const form = new FormData();
    form.append('memberToken', token);
    form.append('file', blob, filename);
    return form;
  }

  const createRes = await fetch(`http://localhost:${PORT}/api/room/create`, { method: 'POST' });
  const { code } = await createRes.json();

  const alice = await connectClient();
  const bob = await connectClient();

  const aliceJoin = await joinRoom(alice, code, 'Alice');

  let alicePresence = null;
  alice.on('room:presence', (p) => { alicePresence = p; });

  const bobJoin = await joinRoom(bob, code, 'Bob');
  await wait(100);

  assert(!aliceJoin.error, 'alice joined');
  assert(!bobJoin.error, 'bob joined');
  assert(alicePresence?.length === 2, 'alice sees 2 presence after bob joins');
  assert(bobJoin.state.presence.length === 2, 'bob sees 2 presence on join');
  assert(
    alicePresence.some((p) => p.name === 'Alice') && alicePresence.some((p) => p.name === 'Bob'),
    'distinct names in presence'
  );

  const john1 = await connectClient();
  const john2 = await connectClient();
  const johnJoin1 = await joinRoom(john1, code, 'john');
  assert(!johnJoin1.error, 'first john joined');
  const johnJoin2 = await joinRoom(john2, code, 'john');
  assert(johnJoin2?.error?.includes('already taken'), 'duplicate john rejected');
  john1.disconnect();
  john2.disconnect();

  const raceSockets = await Promise.all(Array.from({ length: 20 }, () => connectClient()));
  const raceJoins = await Promise.all(raceSockets.map((s) => joinRoom(s, code, 'racejohn')));
  const raceWinners = raceJoins.filter((r) => !r?.error);
  const raceLosers = raceJoins.filter((r) => r?.error?.includes('already taken'));
  assert(raceWinners.length === 1, 'simultaneous duplicate join race: exactly one winner');
  assert(raceLosers.length === 19, 'simultaneous duplicate join race: nineteen rejections');
  raceSockets.forEach((s) => s.disconnect());

  const reuse = await connectClient();
  const reuseJoin = await joinRoom(reuse, code, 'john');
  assert(!reuseJoin.error, 'john name available after prior john left');
  reuse.disconnect();

  let lastChatId = null;
  let bobGotChat = false;
  bob.on('room:message', (msg) => {
    if (msg.type === 'chat' && msg.id) lastChatId = msg.id;
    if (msg.type === 'chat' && msg.text === 'hello bob') bobGotChat = true;
  });

  let bobGotImage = false;
  let bobGotVideo = false;
  let bobGotFile = false;
  let bobGotAudio = false;
  bob.on('room:message', (msg) => {
    if (msg.type === 'image') bobGotImage = true;
    if (msg.type === 'video') bobGotVideo = true;
    if (msg.type === 'file') bobGotFile = true;
    if (msg.type === 'audio') bobGotAudio = true;
  });

  alice.emit('room:chat', { text: 'hello bob' });
  await wait(100);
  assert(bobGotChat, 'bob received chat');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const imageRes = await fetch(`http://localhost:${PORT}/api/room/${code}/attachment`, {
    method: 'POST',
    body: attachmentForm(aliceJoin.memberToken, new Blob([png], { type: 'image/png' }), 'tiny.png'),
  });
  const imageData = await imageRes.json();
  assert(imageRes.ok, 'http image upload ok');
  assert(imageData.message?.type === 'image', 'upload response includes image message');
  await wait(150);
  assert(bobGotImage, 'bob received image');

  const videoRes = await fetch(`http://localhost:${PORT}/api/room/${code}/attachment`, {
    method: 'POST',
    body: attachmentForm(aliceJoin.memberToken, new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'video/mp4' }), 'clip.mp4'),
  });
  const videoData = await videoRes.json();
  assert(videoRes.ok, 'http video upload ok');
  assert(videoData.message?.type === 'video', 'upload response includes video message');
  await wait(150);
  assert(bobGotVideo, 'bob received video');

  const pdfRes = await fetch(`http://localhost:${PORT}/api/room/${code}/attachment`, {
    method: 'POST',
    body: attachmentForm(aliceJoin.memberToken, new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'notes.pdf'),
  });
  const pdfData = await pdfRes.json();
  assert(pdfRes.ok, 'http pdf upload ok');
  assert(pdfData.message?.type === 'file', 'pdf stored as file card');
  await wait(150);
  assert(bobGotFile, 'bob received file card');

  const audioRes = await fetch(`http://localhost:${PORT}/api/room/${code}/attachment`, {
    method: 'POST',
    body: attachmentForm(aliceJoin.memberToken, new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'audio/webm' }), 'voice.webm'),
  });
  const audioData = await audioRes.json();
  assert(audioRes.ok, 'http audio upload ok');
  assert(audioData.message?.type === 'audio' && audioData.message.audioUrl, 'upload response includes audio message');
  await wait(150);
  assert(bobGotAudio, 'bob received voice note');

  const appExtract = await fetch(`http://localhost:${PORT}/api/extract-pdf`, { method: 'POST' });
  assert(appExtract.status !== 404, 'main /api/extract-pdf still exists');

  let bobGotAfterImage = false;
  bob.on('room:message', (msg) => {
    if (msg.type === 'chat' && msg.text === 'after image') bobGotAfterImage = true;
  });
  alice.emit('room:chat', { text: 'after image' });
  await wait(100);
  assert(bobGotAfterImage, 'bob received chat after image');

  let bobTyping = false;
  bob.on('room:typing', (p) => { if (p.name === 'Alice') bobTyping = true; });
  alice.emit('room:typing');
  await wait(80);
  assert(bobTyping, 'bob sees alice typing');

  let reactPayload = null;
  bob.on('room:react', (m) => { reactPayload = m; });
  alice.emit('room:react', { messageId: lastChatId, emoji: '🔥' });
  await wait(80);
  assert(reactPayload?.reactions?.['🔥']?.includes('Alice'), 'alice reacted fire');

  let pinPayload = null;
  bob.on('room:pin', (p) => { pinPayload = p; });
  alice.emit('room:pin', { messageId: lastChatId });
  await wait(80);
  assert(pinPayload?.pinnedId === lastChatId, 'pin set');

  let timerPayload = undefined;
  bob.on('room:timer', (t) => { timerPayload = t; });
  alice.emit('room:timer', { minutes: 90 });
  await wait(80);
  assert(timerPayload?.minutes === 90 && timerPayload.endsAt > Date.now(), 'timer started');
  alice.emit('room:timer', { action: 'stop' });
  await wait(80);
  assert(timerPayload === null, 'timer stopped');

  let callPayload = null;
  bob.on('room:call', (ev) => { callPayload = ev; });
  alice.emit('room:call', { action: 'join' });
  await wait(80);
  assert(callPayload?.action === 'state' && callPayload.peers?.some((p) => p.name === 'Alice'), 'alice joined voice');
  alice.emit('room:call', { action: 'cam', on: true });
  await wait(80);
  assert(callPayload?.peers?.find((p) => p.name === 'Alice')?.camOn === true, 'alice camera on signaled');
  alice.emit('room:call', { action: 'cam', on: false });
  await wait(80);
  assert(callPayload?.peers?.find((p) => p.name === 'Alice')?.camOn === false, 'alice camera off signaled');
  alice.emit('room:call', { action: 'leave' });
  await wait(80);
  assert(callPayload?.action === 'state' && callPayload.peers?.length === 0, 'alice left voice');

  let boardPayload = null;
  bob.on('room:board', (b) => { boardPayload = b; });
  alice.emit('room:board', { action: 'claim' });
  await wait(80);
  assert(boardPayload?.presenterName === 'Alice', 'alice presenting board');
  alice.emit('room:board', { action: 'scene', seq: 1, elements: [{ id: 'rect1', type: 'rectangle', version: 1 }] });
  await wait(80);
  assert(boardPayload?.elements?.[0]?.id === 'rect1', 'bob received board scene');
  alice.emit('room:board', {
    action: 'scene',
    seq: 2,
    elements: [{ id: 'img1', type: 'image', fileId: 'f1', version: 2 }],
    files: { f1: { id: 'f1', dataURL: 'data:image/png;base64,aaa', mimeType: 'image/png' } },
  });
  await wait(80);
  assert(boardPayload?.files?.f1?.dataURL?.startsWith('data:image/png'), 'bob received board image file');
  alice.emit('room:board', { action: 'scene', seq: 1, elements: [] });
  await wait(80);
  assert(boardPayload?.elements?.[0]?.fileId === 'f1', 'stale empty scene does not wipe board');
  alice.emit('room:board', {
    action: 'scene',
    seq: 9,
    elements: [{ id: 'img1', type: 'image', fileId: 'f1', version: 1 }],
    files: {},
  });
  await wait(80);
  assert(boardPayload?.elements?.[0]?.fileId === 'f1', 'older element versions do not wipe board');
  assert(boardPayload?.files?.f1?.dataURL?.startsWith('data:image/png'), 'stale scene keeps image file');
  await wait(80);
  assert(boardPayload?.files?.f1?.dataURL?.startsWith('data:image/png'), 'bob received board image file');
  alice.emit('room:board', {
    action: 'scene',
    elements: [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
    files: { f1: { id: 'f1', dataURL: 'blob:http://localhost/x', mimeType: 'image/png' } },
  });
  await wait(80);
  assert(boardPayload?.files?.f1?.dataURL?.startsWith('data:image/png'), 'blob emit does not wipe durable file');
  assert(boardPayload?.elements?.[0]?.status === 'saved', 'image marked saved for viewers');

  const carol = await connectClient();
  const carolJoin = await joinRoom(carol, code, 'Carol');
  assert(carolJoin.state?.board?.files?.f1?.dataURL?.startsWith('data:image/png'), 'late join gets board files');
  assert(carolJoin.state?.board?.elements?.[0]?.fileId === 'f1', 'late join gets image element');
  carol.disconnect();

  alice.emit('room:board', {
    action: 'scene',
    seq: 20,
    elements: [{ id: 'img1', type: 'image', fileId: 'f1', version: 5, isDeleted: true }],
    files: { f1: { id: 'f1', dataURL: 'data:image/png;base64,aaa', mimeType: 'image/png' } },
  });
  await wait(80);
  assert(boardPayload?.elements?.[0]?.isDeleted === true, 'erase is stored on the shared board');

  const dave = await connectClient();
  const daveJoin = await joinRoom(dave, code, 'Dave');
  assert(daveJoin.state?.board?.elements?.[0]?.isDeleted === true, 'third late joiner gets erased state');
  dave.emit('room:board', { action: 'sync' });
  await wait(80);
  dave.disconnect();

  bob.emit('room:board', { action: 'claim' });
  await wait(80);
  assert(boardPayload?.presenterName === 'Bob', 'bob took over board');
  assert(boardPayload?.elements?.[0]?.fileId === 'f1', 'takeover keeps shared scene');
  assert(boardPayload?.elements?.[0]?.isDeleted === true, 'takeover does not resurrect erased strokes');
  const takeoverSeq = boardPayload.seq;
  alice.emit('room:board', { action: 'scene', seq: takeoverSeq + 1, elements: [{ id: 'hack' }] });
  await wait(80);
  assert(boardPayload?.elements?.[0]?.id !== 'hack', 'old presenter cannot draw after takeover');
  assert(boardPayload?.presenterName === 'Bob', 'stale scene cannot restore old presenter');

  alice.emit('room:board', { action: 'claim' });
  await wait(80);
  assert(boardPayload?.presenterName === 'Alice', 'alice took board back');

  alice.emit('room:board', { action: 'release' });
  await wait(80);
  assert(boardPayload?.presenterId == null, 'alice stopped presenting');

  // Regression: draw 3 shapes, erase 1 -> viewer shows exactly 2 within budget,
  // then switch presenter to viewer -> content stays at exactly 2 (no resurrection).
  const regRoom = await fetch(`http://localhost:${PORT}/api/room/create`, { method: 'POST' }).then((r) => r.json());
  const regCode = regRoom.code;
  const regAlice = await connectClient();
  const regBob = await connectClient();
  const regAliceJoin = await joinRoom(regAlice, regCode, 'RegAlice');
  const regBobJoin = await joinRoom(regBob, regCode, 'RegBob');
  assert(regAliceJoin && !regAliceJoin.error, 'regression room: alice joined');
  assert(regBobJoin && !regBobJoin.error, 'regression room: bob joined');

  let regBoardPayload = null;
  regBob.on('room:board', (b) => { regBoardPayload = b; });
  regAlice.emit('room:board', { action: 'claim' });
  await wait(80);

  const liveShapeCount = (b) => (b?.elements || []).filter((el) => el && !el.isDeleted).length;

  regAlice.emit('room:board', {
    action: 'scene',
    seq: 1,
    elements: [
      { id: 'shape1', type: 'rectangle', version: 1, isDeleted: false },
      { id: 'shape2', type: 'ellipse', version: 1, isDeleted: false },
      { id: 'shape3', type: 'diamond', version: 1, isDeleted: false },
    ],
  });
  await wait(80);
  assert(liveShapeCount(regBoardPayload) === 3, 'regression: bob sees all 3 shapes drawn');

  const eraseStart = Date.now();
  regAlice.emit('room:board', {
    action: 'scene',
    seq: 2,
    elements: [
      { id: 'shape1', type: 'rectangle', version: 2, isDeleted: true },
      { id: 'shape2', type: 'ellipse', version: 1, isDeleted: false },
      { id: 'shape3', type: 'diamond', version: 1, isDeleted: false },
    ],
  });
  await wait(80);
  const eraseElapsedMs = Date.now() - eraseStart;
  assert(liveShapeCount(regBoardPayload) === 2, 'regression: bob sees exactly 2 shapes after erase, no user action needed');
  assert(eraseElapsedMs < 2000, `regression: erase propagated within budget (${eraseElapsedMs}ms)`);

  regBob.emit('room:board', { action: 'claim' });
  await wait(80);
  assert(regBoardPayload?.presenterName === 'RegBob', 'regression: presenter switched to bob');
  assert(liveShapeCount(regBoardPayload) === 2, 'regression: takeover keeps exactly 2 shapes, erase not resurrected');

  regAlice.disconnect();
  regBob.disconnect();

  let announced = false;
  bob.on('room:message', (msg) => {
    if (String(msg.text || '').includes('Posted gap map')) announced = true;
  });

  const gapRes = await fetch(`http://localhost:${PORT}/api/room/${code}/gap-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberToken: aliceJoin.memberToken,
      topic: 'Photosynthesis',
      gapMap: [{ topic: 'Calvin cycle', status: 'shaky', gap_type: 'mechanism' }],
      mastery: { score: 65 },
      sessionId: 'abc',
      announce: true,
    }),
  });
  assert(gapRes.ok, 'gap-sync ok');
  await wait(100);
  assert(announced, 'gap-sync announce posted chat line');

  let bobGotGap = false;
  bob.on('room:gap-maps', (maps) => {
    if (maps.some((m) => m.topic === 'Photosynthesis')) bobGotGap = true;
  });
  await wait(100);

  alice.disconnect();
  bob.disconnect();

  const gapResOffline = await fetch(`http://localhost:${PORT}/api/room/${code}/gap-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberToken: aliceJoin.memberToken,
      topic: 'Photosynthesis v2',
      gapMap: [{ topic: 'Light reactions', status: 'solid', gap_type: 'process' }],
      mastery: { score: 80 },
    }),
  });
  assert(gapResOffline.ok, 'gap-sync works after disconnect');

  console.log('e2e ok:', {
    code,
    css: css.status,
    chat: bobGotChat,
    image: bobGotImage,
    video: bobGotVideo,
    file: bobGotFile,
    gapSync: gapRes.ok,
    offlineGapSync: gapResOffline.ok,
  });
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
