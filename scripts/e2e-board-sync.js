#!/usr/bin/env node
/** Two Chrome sessions: board scene + images survive late join, refresh, reconnect. */

const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, msg, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(msg);
}

async function joinRoom(page, { code, name, create }) {
  await page.goto(`${BASE}/room`, { waitUntil: 'domcontentloaded' });
  if (create) {
    await page.click('#create-room-btn');
    await waitUntil(() => page.$eval('#room-code', (el) => el.value.length >= 4), 'room code filled');
    code = await page.$eval('#room-code', (el) => el.value);
  } else {
    await page.click('#room-code', { clickCount: 3 });
    await page.type('#room-code', code);
  }
  await page.click('#display-name', { clickCount: 3 });
  await page.type('#display-name', name);
  await page.click('#join-room-btn');
  await page.waitForSelector('#room-panel:not(.hidden)', { timeout: 10000 });
  return code;
}

async function fileCount(page) {
  return page.$eval('#board-mount', (el) => el.dataset.fileCount || '0');
}

async function elCount(page) {
  return page.$eval('#board-mount', (el) => el.dataset.elCount || '0');
}

async function pushScene(page, elements, files = {}) {
  await page.evaluate((payload) => {
    window.dispatchEvent(new CustomEvent('room:e2e-board-scene', { detail: payload }));
  }, { elements, files });
}

async function pushImage(page) {
  await page.evaluate((png) => {
    window.dispatchEvent(new CustomEvent('room:e2e-board-scene', {
      detail: {
        elements: [{
          id: 'img1',
          type: 'image',
          fileId: 'f1',
          status: 'pending',
          x: 40,
          y: 40,
          width: 120,
          height: 120,
          isDeleted: false,
        }],
        files: { f1: { id: 'f1', dataURL: png, mimeType: 'image/png', created: Date.now() } },
      },
    }));
  }, PNG);
}

async function main() {
  const browserA = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: CHROME_ARGS });
  const browserB = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: CHROME_ARGS });
  let carolBrowser;
  const alice = await browserA.newPage();
  const bob = await browserB.newPage();
  alice.setDefaultTimeout(15000);
  bob.setDefaultTimeout(15000);

  try {
    const code = await joinRoom(alice, { name: 'Alice', create: true });
    await alice.click('#board-present-btn');
    await waitUntil(
      () => alice.$eval('#board-status', (el) => el.textContent.includes('You are presenting')),
      'alice presenting'
    );
    await pushImage(alice);
    await waitUntil(async () => (await fileCount(alice)) === '1', 'alice stored image file');

    await joinRoom(bob, { name: 'Bob', code });
    await waitUntil(async () => (await fileCount(bob)) === '1', 'late join bob sees image file');
    await waitUntil(
      () => bob.$eval('#board-status', (el) => el.textContent.includes('Alice presenting')),
      'bob sees alice presenting'
    );

    await pushScene(alice, [
      { id: 'img1', type: 'image', fileId: 'f1', version: 2, isDeleted: false },
      { id: 's1', type: 'freedraw', version: 1, isDeleted: false, points: [[0, 0], [8, 8]] },
    ], { f1: { id: 'f1', dataURL: PNG, mimeType: 'image/png' } });
    await waitUntil(async () => (await elCount(bob)) === '2', 'bob sees first live stroke without refresh');

    await pushScene(alice, [
      { id: 'img1', type: 'image', fileId: 'f1', version: 2, isDeleted: false },
      { id: 's1', type: 'freedraw', version: 1, isDeleted: false, points: [[0, 0], [8, 8]] },
      { id: 's2', type: 'freedraw', version: 1, isDeleted: false, points: [[2, 2], [9, 1]] },
    ], { f1: { id: 'f1', dataURL: PNG, mimeType: 'image/png' } });
    await waitUntil(async () => (await elCount(bob)) === '3', 'bob sees second live stroke without refresh');

    await pushScene(alice, [
      { id: 'img1', type: 'image', fileId: 'f1', version: 2, isDeleted: false },
      { id: 's1', type: 'freedraw', version: 1, isDeleted: false, points: [[0, 0], [8, 8]] },
      { id: 's2', type: 'freedraw', version: 1, isDeleted: false, points: [[2, 2], [9, 1]] },
      { id: 's3', type: 'freedraw', version: 1, isDeleted: false, points: [[4, 0], [4, 12]] },
    ], { f1: { id: 'f1', dataURL: PNG, mimeType: 'image/png' } });
    await waitUntil(async () => (await elCount(bob)) === '4', 'bob sees third live stroke without refresh');

    await pushScene(alice, [
      { id: 'img1', type: 'image', fileId: 'f1', version: 3, isDeleted: true },
      { id: 's1', type: 'freedraw', version: 2, isDeleted: true },
      { id: 's2', type: 'freedraw', version: 1, isDeleted: false, points: [[2, 2], [9, 1]] },
      { id: 's3', type: 'freedraw', version: 1, isDeleted: false, points: [[4, 0], [4, 12]] },
    ], { f1: { id: 'f1', dataURL: PNG, mimeType: 'image/png' } });
    await waitUntil(async () => (await elCount(bob)) === '2', 'bob sees erase without refresh');

    carolBrowser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: CHROME_ARGS });
    const carol = await carolBrowser.newPage();
    carol.setDefaultTimeout(15000);
    await joinRoom(carol, { name: 'Carol', code });
    await waitUntil(async () => (await elCount(carol)) === '2', 'late joiner carol matches live board');
    await waitUntil(
      () => carol.$eval('#board-status', (el) => el.textContent.includes('Alice presenting')),
      'carol is view-only'
    );

    await waitUntil(
      () => bob.$eval('#board-present-btn', (el) => el.textContent.includes('Take over')),
      'bob is view-only with Take over'
    );

    await bob.click('#board-present-btn');
    await waitUntil(
      () => alice.$eval('#board-status', (el) => el.textContent.includes('Bob presenting')),
      'alice sees bob presenting after takeover'
    );
    await waitUntil(async () => (await fileCount(alice)) === '1', 'alice still has image after takeover');
    await waitUntil(async () => (await fileCount(bob)) === '1', 'bob still has image after takeover');
    await waitUntil(
      () => alice.$eval('#board-present-btn', (el) => el.textContent.includes('Take over')),
      'alice is view-only after takeover'
    );
    await waitUntil(async () => (await elCount(alice)) === '2', 'handoff does not resurrect erased strokes');
    await waitUntil(async () => (await elCount(carol)) === '2', 'carol stays in sync after takeover');

    await pushScene(bob, [
      { id: 's2', type: 'freedraw', version: 1, isDeleted: false },
      { id: 's3', type: 'freedraw', version: 1, isDeleted: false },
      { id: 's4', type: 'freedraw', version: 1, isDeleted: false },
    ]);
    await waitUntil(async () => (await elCount(alice)) === '3', 'alice sees bob draw after takeover');
    await waitUntil(async () => (await elCount(carol)) === '3', 'carol sees bob draw');

    await alice.click('#board-present-btn');
    await waitUntil(
      () => bob.$eval('#board-status', (el) => el.textContent.includes('Alice presenting')),
      'bob sees alice presenting again'
    );
    await waitUntil(async () => (await fileCount(bob)) === '1', 'bob still has image after reverse takeover');
    await waitUntil(async () => (await fileCount(alice)) === '1', 'alice still has image after reverse takeover');

    await bob.reload({ waitUntil: 'domcontentloaded' });
    await bob.waitForSelector('#room-panel:not(.hidden)', { timeout: 10000 });
    await waitUntil(async () => (await fileCount(bob)) === '1', 'bob refresh still has image file');

    await bob.evaluate(() => {
      const s = window.io?.sockets || null;
      return s;
    });
    const client = await bob.target().createCDPSession();
    await client.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await sleep(400);
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await waitUntil(async () => (await fileCount(bob)) === '1', 'bob reconnect still has image file');

    console.log('ok: board files shared on late join, takeover, refresh, reconnect');
  } finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
    await carolBrowser?.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
