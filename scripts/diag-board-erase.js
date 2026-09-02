#!/usr/bin/env node
/**
 * Diagnostic: real-Excalidraw erase flow.
 * Drives actual mouse draws + eraser tool (NOT the synthetic e2e event), and logs:
 *  (a) erase handler activity  -> every outgoing room:board emit (action, seq, els, bytes)
 *  (b) socket lifecycle        -> connect/disconnect events per client
 *  (c) page errors / console   -> any exception thrown during erase or broadcast
 * Run with a server already up: BASE_URL=http://localhost:3012 node scripts/diag-board-erase.js
 */

const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, msg, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(120);
  }
  console.error(`TIMEOUT: ${msg}`);
  return false;
}

const INSTRUMENT = () => {
  window.__boardEmits = [];
  window.__sockEvents = [];
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) =>
    window.__errors.push(`unhandledrejection: ${e.reason?.message || e.reason}`));
  let realIo;
  Object.defineProperty(window, 'io', {
    configurable: true,
    set(v) { realIo = v; },
    get() {
      if (!realIo) return undefined;
      const wrapped = (...args) => {
        const s = realIo(...args);
        const emit = s.emit.bind(s);
        s.emit = (ev, ...rest) => {
          if (ev === 'room:board') {
            try {
              const p = rest[0] || {};
              window.__boardEmits.push({
                t: Date.now(),
                action: p.action,
                seq: p.seq,
                els: Array.isArray(p.elements) ? p.elements.length : null,
                live: Array.isArray(p.elements) ? p.elements.filter((el) => el && !el.isDeleted).length : null,
                deleted: Array.isArray(p.elements) ? p.elements.filter((el) => el?.isDeleted).length : null,
                bytes: JSON.stringify(p).length,
              });
            } catch { /* diagnostic only */ }
          }
          return emit(ev, ...rest);
        };
        s.on('connect', () => window.__sockEvents.push({ ev: 'connect', id: s.id, t: Date.now() }));
        s.on('disconnect', (r) => window.__sockEvents.push({ ev: 'disconnect', reason: r, t: Date.now() }));
        return s;
      };
      Object.assign(wrapped, realIo);
      return wrapped;
    },
  });
};

async function newClient(name) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: CHROME_ARGS });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(20000);
  const consoleLog = [];
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) consoleLog.push(`[${name}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleLog.push(`[${name}] pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(INSTRUMENT);
  return { browser, page, consoleLog, name };
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
  await page.waitForSelector('#room-panel:not(.hidden)');
  return code;
}

const elCount = (page) => page.$eval('#board-mount', (el) => el.dataset.elCount || '0');
const lastEmit = (page) => page.evaluate(() => window.__boardEmits[window.__boardEmits.length - 1] || null);
const liveInLastEmit = async (page) => (await lastEmit(page))?.live ?? -1;

async function boardBox(page) {
  await page.waitForSelector('#board-mount canvas');
  // Excalidraw interaction handlers come up after the toolbar renders; interacting
  // earlier gets pointer events silently swallowed.
  await page.waitForSelector('#board-mount .App-toolbar, #board-mount [data-testid="toolbar-rectangle"]', { timeout: 20000 });
  await sleep(400);
  return page.$eval('#board-mount', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

async function activateTool(page, testId, fallbackKey) {
  const clicked = await page.evaluate((id) => {
    const btn = document.querySelector(`#board-mount [data-testid="${id}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, testId);
  if (!clicked) await page.keyboard.press(fallbackKey);
  await sleep(150);
  return page.evaluate((id) => {
    const btn = document.querySelector(`#board-mount [data-testid="${id}"]`);
    return btn ? (btn.checked ?? btn.getAttribute('aria-pressed') ?? 'found-unknown') : 'button-missing';
  }, testId);
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(250);
}

/** Draw rect #n and verify via the presenter's own outgoing emits (ground truth of onChange). */
async function drawRectVerified(page, box, n, expectedLive) {
  const x = box.x + 100 + n * 170;
  const y = box.y + 140;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('Escape');
    await sleep(80);
    const state = await activateTool(page, 'toolbar-rectangle', '2');
    if (attempt > 0) console.log(`    rectangle tool state: ${state}`);
    await drag(page, { x, y }, { x: x + 90, y: y + 80 });
    const ok = await waitUntil(async () => (await liveInLastEmit(page)) >= expectedLive,
      `local onChange emitted ${expectedLive} live after rect ${n + 1} (attempt ${attempt + 1})`, 3000);
    if (ok) return true;
  }
  return false;
}

async function report(client, label) {
  const data = await client.page.evaluate(() => ({
    emits: window.__boardEmits,
    sock: window.__sockEvents,
    errors: window.__errors,
  }));
  console.log(`\n=== ${label} (${client.name}) ===`);
  console.log('socket lifecycle:', JSON.stringify(data.sock));
  console.log('board emits (t, action, seq, els/live/deleted, bytes):');
  for (const e of data.emits) {
    console.log(`  ${e.t} ${e.action} seq=${e.seq ?? '-'} els=${e.els ?? '-'} live=${e.live ?? '-'} del=${e.deleted ?? '-'} ${e.bytes}B`);
  }
  console.log('uncaught errors:', JSON.stringify(data.errors));
  console.log(client.consoleLog.length ? `console:\n${client.consoleLog.join('\n')}` : 'console: clean');
}

async function main() {
  const alice = await newClient('alice');
  const bob = await newClient('bob');
  const results = {};
  try {
    const code = await joinRoom(alice.page, { name: 'Alice', create: true });
    await joinRoom(bob.page, { name: 'Bob', code });

    await alice.page.click('#board-present-btn');
    await waitUntil(
      () => alice.page.$eval('#board-status', (el) => el.textContent.includes('You are presenting')),
      'alice presenting'
    );
    const box = await boardBox(alice.page);
    await alice.page.mouse.click(box.x + box.w - 60, box.y + box.h - 60);

    console.log('STEP 1: draw 3 rectangles (verified against local onChange emits)');
    for (let n = 0; n < 3; n++) {
      const ok = await drawRectVerified(alice.page, box, n, n + 1);
      console.log(`  rect ${n + 1} locally registered: ${ok ? 'OK' : 'FAIL'}`);
    }
    results.draw3 = await waitUntil(async () => (await elCount(bob.page)) === '3', 'bob sees 3 shapes');
    console.log(`  bob elCount: ${await elCount(bob.page)} (expected 3) ${results.draw3 ? 'OK' : 'FAIL'}`);

    console.log('STEP 2a: erase rect 1 with the eraser tool (drag)');
    const before = await alice.page.evaluate(() => window.__boardEmits.length);
    await alice.page.keyboard.press('Escape');
    await sleep(80);
    const eraserState = await activateTool(alice.page, 'toolbar-eraser', 'e');
    console.log(`  eraser tool state after activation: ${eraserState}`);
    const ex = box.x + 100;
    const ey = box.y + 140;
    // Excalidraw rectangles are transparent: hit-test registers on the STROKE only,
    // so the eraser path must cross the border, not the interior.
    await drag(alice.page, { x: ex - 25, y: ey + 40 }, { x: ex + 115, y: ey + 40 });
    const eraserWorked = await waitUntil(async () => {
      const emits = await alice.page.evaluate(() => window.__boardEmits);
      return emits.slice(before).some((e) => e.action === 'scene' && (e.live === 2 || e.deleted > 0));
    }, 'eraser drag produced an outgoing scene emit with 2 live', 4000);
    console.log(`  eraser drag deleted + emitted: ${eraserWorked ? 'OK' : 'FAIL'}`);

    console.log(`  onChange debug after eraser: ${JSON.stringify(await alice.page.evaluate(() => window.__boardDebug))}`);

    if (!eraserWorked) {
      console.log('STEP 2b: fallback delete path — select rect 1 by its border, press Delete');
      await activateTool(alice.page, 'toolbar-selection', '1');
      await alice.page.mouse.click(ex, ey + 40);
      await sleep(250);
      console.log(`  onChange debug after select-click: ${JSON.stringify(await alice.page.evaluate(() => window.__boardDebug))}`);
      await alice.page.keyboard.press('Delete');
      await sleep(250);
      console.log(`  onChange debug after Delete: ${JSON.stringify(await alice.page.evaluate(() => window.__boardDebug))}`);
    }
    results.eraseEmitted = await waitUntil(async () => {
      const emits = await alice.page.evaluate(() => window.__boardEmits);
      return emits.slice(before).some((e) => e.action === 'scene' && (e.live === 2 || e.deleted > 0));
    }, 'delete produced an outgoing scene emit with 2 live elements', 4000);
    console.log(`  delete emitted over the same channel: ${results.eraseEmitted ? 'OK' : 'FAIL'}`);
    results.erase = await waitUntil(async () => (await elCount(bob.page)) === '2', 'bob sees erase (2 live)');
    console.log(`  bob elCount: ${await elCount(bob.page)} (expected 2) ${results.erase ? 'OK' : 'FAIL'}`);

    console.log('STEP 3: draw a 4th rectangle AFTER the erase (post-erase sync alive?)');
    const drew4 = await drawRectVerified(alice.page, box, 3, 3);
    console.log(`  rect 4 locally registered: ${drew4 ? 'OK' : 'FAIL'}`);
    results.postDraw = await waitUntil(async () => (await elCount(bob.page)) === '3', 'bob sees post-erase draw (3 live)');
    console.log(`  bob elCount: ${await elCount(bob.page)} (expected 3) ${results.postDraw ? 'OK' : 'FAIL'}`);

    console.log('STEP 4: takeover -> erased shape must stay gone');
    await bob.page.click('#board-present-btn');
    await waitUntil(
      () => alice.page.$eval('#board-status', (el) => el.textContent.includes('Bob presenting')),
      'alice sees bob presenting'
    );
    await sleep(600);
    const aAfter = await elCount(alice.page);
    const bAfter = await elCount(bob.page);
    results.takeover = aAfter === '3' && bAfter === '3';
    console.log(`  alice=${aAfter} bob=${bAfter} (expected 3/3, NOT 4) ${results.takeover ? 'OK' : 'FAIL'}`);

    await report(alice, 'PRESENTER instrumentation');
    await report(bob, 'VIEWER instrumentation');

    const ok = Object.values(results).every(Boolean);
    console.log(`\nDIAG RESULT: ${ok ? 'full erase flow healthy' : `BROKEN -> ${JSON.stringify(results)}`}`);
    process.exit(ok ? 0 : 1);
  } finally {
    await alice.browser.close().catch(() => {});
    await bob.browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
