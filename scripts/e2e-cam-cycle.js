#!/usr/bin/env node
/** Two Chrome sessions: camera ON/OFF cycles on a live Study Room call. */

const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function snapshot(page) {
  return page.evaluate(() => [...document.querySelectorAll('.room-call-tile')].map((tile) => {
    const v = tile.querySelector('video');
    const stream = v?.srcObject;
    const liveVideo = stream ? stream.getVideoTracks().filter((t) => t.readyState === 'live') : [];
    return {
      name: tile.querySelector('.room-call-tile-name')?.textContent || '',
      local: tile.classList.contains('local'),
      hasVideo: tile.classList.contains('has-video'),
      videoWidth: v?.videoWidth || 0,
      srcVideo: liveVideo.length,
      camLabel: document.querySelector('#call-cam-btn')?.textContent || '',
      camOn: tile.dataset.camOn || '',
      tracks: stream ? stream.getVideoTracks().map((t) => ({
        ready: t.readyState,
        muted: t.muted,
        enabled: t.enabled,
      })) : [],
    };
  }));
}

async function waitUntil(fn, msg, timeout = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`${msg} (last=${JSON.stringify(last)})`);
}

async function hookPage(page, label) {
  page.on('console', (msg) => console.log(`[${label}]`, msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log(`[${label} ERR]`, err.message));
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

async function joinCall(page) {
  await page.click('#call-btn');
  await page.waitForSelector('#call-cam-btn:not(.hidden)', { timeout: 10000 });
}

async function tile(page, name) {
  const tiles = await snapshot(page);
  return tiles.find((t) => t.name === name);
}

async function expectTile(page, name, { hasVideo }, label) {
  await waitUntil(async () => {
    const t = await tile(page, name);
    if (!t) return false;
    if (hasVideo) return t.hasVideo && t.srcVideo > 0;
    return !t.hasVideo && t.srcVideo === 0;
  }, label);
}

async function main() {
  const browserA = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: CHROME_ARGS,
  });
  const browserB = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: CHROME_ARGS,
  });
  const alice = await browserA.newPage();
  const bob = await browserB.newPage();
  await hookPage(alice, 'alice');
  await hookPage(bob, 'bob');
  alice.setDefaultTimeout(15000);
  bob.setDefaultTimeout(15000);

  try {
    const code = await joinRoom(alice, { name: 'Alice', create: true });
    await joinRoom(bob, { name: 'Bob', code });
    await joinCall(alice);
    await joinCall(bob);
    await waitUntil(async () => (await snapshot(alice)).length === 2, 'alice sees 2 tiles');
    await waitUntil(async () => (await snapshot(bob)).length === 2, 'bob sees 2 tiles');

    await expectTile(alice, 'You', { hasVideo: false }, 'alice local off at start');
    await expectTile(alice, 'Bob', { hasVideo: false }, 'alice remote off at start');
    await expectTile(bob, 'You', { hasVideo: false }, 'bob local off at start');
    await expectTile(bob, 'Alice', { hasVideo: false }, 'bob remote off at start');

    // ON → OFF
    await alice.click('#call-cam-btn');
    await expectTile(alice, 'You', { hasVideo: true }, 'alice ON local');
    await expectTile(bob, 'Alice', { hasVideo: true }, 'bob sees alice ON');
    await alice.click('#call-cam-btn');
    await expectTile(alice, 'You', { hasVideo: false }, 'alice OFF local (no frozen frame)');
    await expectTile(bob, 'Alice', { hasVideo: false }, 'bob sees alice OFF (no frozen frame)');

    // OFF → ON → OFF
    await alice.click('#call-cam-btn');
    await expectTile(alice, 'You', { hasVideo: true }, 'alice ON again');
    await expectTile(bob, 'Alice', { hasVideo: true }, 'bob sees alice ON again');
    await alice.click('#call-cam-btn');
    await expectTile(alice, 'You', { hasVideo: false }, 'alice OFF again');
    await expectTile(bob, 'Alice', { hasVideo: false }, 'bob sees alice OFF again');

    // both OFF already → both ON together
    await Promise.all([alice.click('#call-cam-btn'), bob.click('#call-cam-btn')]);
    await expectTile(alice, 'You', { hasVideo: true }, 'both-on alice local');
    await expectTile(bob, 'You', { hasVideo: true }, 'both-on bob local');
    await expectTile(alice, 'Bob', { hasVideo: true }, 'both-on alice sees bob');
    await expectTile(bob, 'Alice', { hasVideo: true }, 'both-on bob sees alice');

    // both OFF together
    await Promise.all([alice.click('#call-cam-btn'), bob.click('#call-cam-btn')]);
    await expectTile(alice, 'You', { hasVideo: false }, 'both-off alice local');
    await expectTile(bob, 'You', { hasVideo: false }, 'both-off bob local');
    await expectTile(alice, 'Bob', { hasVideo: false }, 'both-off alice sees bob');
    await expectTile(bob, 'Alice', { hasVideo: false }, 'both-off bob sees alice');

    // alternating
    await alice.click('#call-cam-btn');
    await expectTile(bob, 'Alice', { hasVideo: true }, 'alt alice on');
    await bob.click('#call-cam-btn');
    await expectTile(alice, 'Bob', { hasVideo: true }, 'alt bob on');
    await alice.click('#call-cam-btn');
    await expectTile(bob, 'Alice', { hasVideo: false }, 'alt alice off');
    await bob.click('#call-cam-btn');
    await expectTile(alice, 'Bob', { hasVideo: false }, 'alt bob off');
    await expectTile(alice, 'You', { hasVideo: false }, 'alt end alice local off');
    await expectTile(bob, 'You', { hasVideo: false }, 'alt end bob local off');

    console.log('ok: camera cycles blank both sides, recover without rejoin');
  } catch (err) {
    console.error('alice tiles', JSON.stringify(await snapshot(alice).catch(() => null)));
    console.error('bob tiles', JSON.stringify(await snapshot(bob).catch(() => null)));
    throw err;
  } finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
