const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('room board lib', () => {
  it('reads Excalidraw off the default CDN export', async () => {
    const { resolveExcalidrawExport } = await import('../public/room-board.js');
    const Comp = function Excalidraw() {};
    assert.equal(resolveExcalidrawExport({ default: { Excalidraw: Comp } }), Comp);
    assert.equal(resolveExcalidrawExport({ Excalidraw: Comp }), Comp);
    assert.equal(resolveExcalidrawExport({ default: Comp }), Comp);
    assert.equal(resolveExcalidrawExport({}), null);
  });

  it('only treats data URLs and uploaded paths as shareable board images', async () => {
    const { isDurableImageRef, filesToMap, normalizeBoardElements } = await import('../public/room-board.js');
    assert.equal(isDurableImageRef('data:image/png;base64,aaa'), true);
    assert.equal(isDurableImageRef('/uploads/rooms/ABC123/x.png'), true);
    assert.equal(isDurableImageRef('blob:http://localhost:3000/uuid'), false);
    assert.equal(isDurableImageRef('https://evil.example/x.png'), false);

    const fromMap = filesToMap(new Map([['f1', { id: 'f1', dataURL: 'data:image/png;base64,x' }]]));
    assert.equal(fromMap.f1.id, 'f1');

    const els = normalizeBoardElements(
      [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
      { f1: { id: 'f1', dataURL: 'data:image/png;base64,x', mimeType: 'image/png' } }
    );
    assert.equal(els[0].status, 'saved');
  });

  it('applies board files before elements so viewers do not cache empty images', async () => {
    const { syncBoardScene } = await import('../public/room-board.js');
    const calls = [];
    const api = {
      addFiles: (list) => calls.push(['addFiles', list.length]),
      updateScene: (scene) => calls.push(['updateScene', scene.elements[0].status]),
    };
    syncBoardScene(api, [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }], {
      f1: { id: 'f1', dataURL: 'data:image/png;base64,x', mimeType: 'image/png' },
    });
    assert.deepEqual(calls, [['addFiles', 1], ['updateScene', 'saved']]);
  });

  it('keeps prior durable files when the new presenter emits an empty file map', async () => {
    const { mergeBoardFiles, prepareBoardScene } = await import('../public/room-board.js');
    const prev = { f1: { id: 'f1', dataURL: '/uploads/rooms/ABC/a.png', mimeType: 'image/png' } };
    const merged = mergeBoardFiles(prev, {});
    assert.equal(merged.f1.dataURL, '/uploads/rooms/ABC/a.png');

    const scene = prepareBoardScene(
      [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
      {},
      prev
    );
    assert.equal(scene.files.f1, undefined, 'server-known file is not re-sent');
    assert.equal(scene.elements[0].status, 'saved');
    assert.equal(scene.elements.length, 1, 'image element referencing the durable file is kept');
  });

  it('ignores remote board packets older than the last applied seq', async () => {
    const { isRemoteBoardStale } = await import('../public/room-board.js');
    assert.equal(isRemoteBoardStale(2, 1), true);
    assert.equal(isRemoteBoardStale(2, 2), false);
    assert.equal(isRemoteBoardStale(2, 3), false);
    assert.equal(isRemoteBoardStale(-1, 1), false);
  });

  it('drops a board apply after a newer packet started resolving files', async () => {
    const { shouldCommitBoardApply } = await import('../public/room-board.js');
    assert.equal(shouldCommitBoardApply({ incomingSeq: 4, lastSeq: 5, applyGen: 1, currentGen: 2 }), false);
    assert.equal(shouldCommitBoardApply({ incomingSeq: 5, lastSeq: 5, applyGen: 2, currentGen: 2 }), true);
    assert.equal(shouldCommitBoardApply({ incomingSeq: 6, lastSeq: 5, applyGen: 3, currentGen: 3 }), true);
    assert.equal(shouldCommitBoardApply({ incomingSeq: 3, lastSeq: 5, applyGen: 3, currentGen: 3 }), false);
  });

  it('flushes a board push when live element ids change', async () => {
    const { liveElementIds, liveElementCount, shouldFlushBoardScene } = await import('../public/room-board.js');
    const a = [{ id: 's1', isDeleted: false }, { id: 'gone', isDeleted: true }];
    const b = [{ id: 's1', isDeleted: false }, { id: 's2', isDeleted: false }];
    assert.equal(liveElementCount(a), 1);
    assert.equal(liveElementCount(b), 2);
    assert.equal(shouldFlushBoardScene(liveElementIds(a), liveElementIds(b)), true);
    assert.equal(shouldFlushBoardScene(liveElementIds(b), liveElementIds(b)), false);
    const erased = [{ id: 's1', isDeleted: true }, { id: 's2', isDeleted: false }];
    assert.equal(shouldFlushBoardScene(liveElementIds(b), liveElementIds(erased)), true);
  });

  it('does not re-send files the server already has (payload stays under socket cap)', async () => {
    const { prepareBoardScene } = await import('../public/room-board.js');
    const prev = { f1: { id: 'f1', dataURL: '/uploads/rooms/A/a.png', mimeType: 'image/png' } };
    const scene = prepareBoardScene(
      [
        { id: 'img1', type: 'image', fileId: 'f1' },
        { id: 'img2', type: 'image', fileId: 'f2' },
      ],
      {
        f1: { id: 'f1', dataURL: 'data:image/png;base64,hugelocalcopy', mimeType: 'image/png' },
        f2: { id: 'f2', dataURL: 'data:image/png;base64,brandnew', mimeType: 'image/png' },
      },
      prev
    );
    assert.deepEqual(Object.keys(scene.files), ['f2'], 'only the file the server lacks is sent');
    assert.equal(scene.elements.length, 2, 'elements referencing server-known files are kept');
    assert.equal(scene.elements[0].status, 'saved');
  });

  it('uploads each large board image once, then reuses the uploaded URL', async () => {
    const { persistBoardFiles } = await import('../public/room-board.js');
    const big = `data:image/png;base64,${'a'.repeat(500000)}`;
    let uploads = 0;
    const uploadDataUrl = async () => {
      uploads += 1;
      return '/uploads/rooms/A/cached.png';
    };
    const files = { fbig: { id: 'fbig', dataURL: big, mimeType: 'image/png' } };
    const first = await persistBoardFiles(files, uploadDataUrl);
    const second = await persistBoardFiles(files, uploadDataUrl);
    assert.equal(first.fbig.dataURL, '/uploads/rooms/A/cached.png');
    assert.equal(second.fbig.dataURL, '/uploads/rooms/A/cached.png');
    assert.equal(uploads, 1, 'second emit must reuse the cached upload, not re-POST');
  });

  it('keeps deleted tombstones in the scene so viewers can drop erased elements', async () => {
    const { prepareBoardScene } = await import('../public/room-board.js');
    const scene = prepareBoardScene(
      [
        { id: 's1', type: 'freedraw', isDeleted: true, version: 2 },
        { id: 'img1', type: 'image', fileId: 'f1', isDeleted: true, version: 3 },
      ],
      {},
      { f1: { id: 'f1', dataURL: '/uploads/rooms/ABC/a.png', mimeType: 'image/png' } }
    );
    assert.equal(scene.elements.find((el) => el.id === 's1').isDeleted, true);
    assert.equal(scene.elements.find((el) => el.id === 'img1').isDeleted, true);
  });

  it('turns uploaded board paths into data URLs for Excalidraw', async () => {
    const { isDurableImageRef, blobToDataURL, resolveBoardFiles } = await import('../public/room-board.js');
    assert.equal(isDurableImageRef('/uploads/rooms/ABC/x.png'), true);
    assert.equal(await blobToDataURL('data:image/png;base64,aaa'), 'data:image/png;base64,aaa');

    const origFetch = global.fetch;
    global.fetch = async (url) => {
      assert.equal(url, '/uploads/rooms/ABC/x.png');
      return {
        ok: true,
        blob: async () => new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }),
      };
    };
    try {
      const out = await resolveBoardFiles({
        f1: { id: 'f1', dataURL: '/uploads/rooms/ABC/x.png', mimeType: 'image/png' },
      });
      assert.match(out.f1.dataURL, /^data:image\/png;base64,/);
    } finally {
      global.fetch = origFetch;
    }
  });
});
