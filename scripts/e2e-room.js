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
  const roomPage = await get('/room/TESTXY');

  assert(css.headers['content-type']?.includes('text/css'), 'room.css content-type');
  assert(css.body.includes('.room-app'), 'room.css has styles');
  assert(styles.status === 200, 'styles.css 200');
  assert(js.status === 200 && js.body.includes('room:join'), 'room.js loads');
  assert(roomPage.body.includes('href="/room.css"'), 'room.html uses absolute css path');

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

  let bobGotChat = false;
  bob.on('room:message', (msg) => {
    if (msg.type === 'chat' && msg.text === 'hello bob') bobGotChat = true;
  });

  let bobGotImage = false;
  bob.on('room:message', (msg) => {
    if (msg.type === 'image') bobGotImage = true;
  });

  alice.emit('room:chat', { text: 'hello bob' });
  await wait(100);
  assert(bobGotChat, 'bob received chat');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  alice.emit('room:image', { mime: 'image/png', data: png.toString('base64') });
  await wait(200);
  assert(bobGotImage, 'bob received image');

  const gapRes = await fetch(`http://localhost:${PORT}/api/room/${code}/gap-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberToken: aliceJoin.memberToken,
      topic: 'Photosynthesis',
      gapMap: [{ topic: 'Calvin cycle', status: 'shaky', gap_type: 'mechanism' }],
      mastery: { score: 65 },
      sessionId: 'abc',
    }),
  });
  assert(gapRes.ok, 'gap-sync ok');

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

  console.log('e2e ok:', { code, css: css.status, chat: bobGotChat, image: bobGotImage, gapSync: gapRes.ok, offlineGapSync: gapResOffline.ok });
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
