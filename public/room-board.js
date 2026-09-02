const EXCALIDRAW_VER = '0.17.6';
const ASSET_PATH = `https://unpkg.com/@excalidraw/excalidraw@${EXCALIDRAW_VER}/dist/`;

let React;
let createRoot;
let Excalidraw;
let root;
let api;
let loadPromise;
let seeded = false;
let latest = { isPresenter: false, elements: [], files: {}, onChange: null, el: null };

let applyingRemote = 0;

function hydrateBoard() {
  if (!api) return;
  applyingRemote += 1;
  try {
    syncBoardScene(api, latest.elements, latest.files);
  } finally {
    const release = () => {
      applyingRemote = Math.max(0, applyingRemote - 1);
    };
    queueMicrotask(() => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(release));
      } else release();
    });
  }
  const stored = api.getFiles?.() || latest.files;
  if (latest.el) {
    latest.el.dataset.hydratedFiles = String(Object.keys(filesToMap(stored)).length);
  }
}

export function resolveExcalidrawExport(mod) {
  const lib = mod?.default ?? mod;
  if (lib?.Excalidraw) return lib.Excalidraw;
  if (typeof lib === 'function') return lib;
  return null;
}

export function isDurableImageRef(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('data:image/')) return true;
  if (url.startsWith('/uploads/rooms/') && !url.includes('..') && !url.includes('\\')) return true;
  return false;
}

export function isRemoteBoardStale(appliedSeq, incomingSeq) {
  const applied = Number(appliedSeq);
  const incoming = Number(incomingSeq);
  if (!Number.isFinite(applied) || !Number.isFinite(incoming)) return false;
  if (applied < 0) return false;
  return incoming < applied;
}

export function shouldCommitBoardApply({ incomingSeq, lastSeq, applyGen, currentGen }) {
  if (applyGen !== currentGen) return false;
  return !isRemoteBoardStale(lastSeq, incomingSeq);
}

export function liveElementCount(elements) {
  return (elements || []).filter((el) => el && !el.isDeleted).length;
}

export function liveElementIds(elements) {
  return (elements || []).filter((el) => el && !el.isDeleted).map((el) => el.id).join('\0');
}

export function shouldFlushBoardScene(prevIds, nextIds) {
  return prevIds !== nextIds;
}

export function filesToMap(files) {
  if (!files) return {};
  if (files instanceof Map) return Object.fromEntries(files);
  if (typeof files !== 'object' || Array.isArray(files)) return {};
  return { ...files };
}

export function normalizeBoardElements(elements, files) {
  const map = filesToMap(files);
  if (!Array.isArray(elements)) return [];
  return elements.map((el) => {
    if (el && el.type === 'image' && el.fileId && map[el.fileId] && isDurableImageRef(map[el.fileId].dataURL)) {
      return { ...el, status: 'saved' };
    }
    return el;
  });
}

export function syncBoardScene(api, elements, files) {
  if (!api) return;
  const map = filesToMap(files);
  const list = Object.values(map).filter((f) => f && isDurableImageRef(f.dataURL));
  if (list.length && api.addFiles) api.addFiles(list);
  api.updateScene?.({ elements: normalizeBoardElements(elements, map), commitToHistory: false });
}

export async function blobToDataURL(src) {
  if (!src || typeof src !== 'string') return '';
  if (src.startsWith('data:image/')) return src;
  if (!src.startsWith('blob:') && !(src.startsWith('/uploads/rooms/') && isDurableImageRef(src))) return '';
  const res = await fetch(src);
  if (!res.ok) return '';
  const blob = await res.blob();
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  return `data:${blob.type || 'image/png'};base64,${buf.toString('base64')}`;
}

export async function resolveBoardFiles(files) {
  const map = filesToMap(files);
  const out = {};
  for (const [rawId, file] of Object.entries(map)) {
    if (!file) continue;
    let url = typeof file.dataURL === 'string' ? file.dataURL : '';
    if (!url.startsWith('data:image/')) {
      try {
        url = await blobToDataURL(url);
      } catch {
        continue;
      }
    }
    if (!url.startsWith('data:image/')) continue;
    const id = String(file.id || rawId).slice(0, 64);
    out[id] = {
      id,
      dataURL: url,
      mimeType: String(file.mimeType || 'image/png').slice(0, 64),
      created: Number(file.created) || Date.now(),
    };
  }
  return out;
}

// Excalidraw file ids are content hashes, so one upload per id is safe. Without
// this cache every stroke re-POSTed every large image and could blow the
// server's socket payload cap, which hard-disconnects the presenter.
const uploadedBoardFiles = new Map();

export async function persistBoardFiles(files, uploadDataUrl) {
  const map = filesToMap(files);
  const out = {};
  for (const [rawId, file] of Object.entries(map)) {
    if (!file) continue;
    const id = String(file.id || rawId).slice(0, 64);
    let url = typeof file.dataURL === 'string' ? file.dataURL : '';
    if (url.startsWith('blob:')) {
      try {
        url = await blobToDataURL(url);
      } catch {
        continue;
      }
    }
    if (url.startsWith('data:image/') && url.length > 400000 && typeof uploadDataUrl === 'function') {
      if (uploadedBoardFiles.has(id)) {
        url = uploadedBoardFiles.get(id);
      } else {
        try {
          url = await uploadDataUrl(url, file.mimeType || 'image/png');
          uploadedBoardFiles.set(id, url);
        } catch {
          /* keep data URL if upload fails */
        }
      }
    }
    if (!isDurableImageRef(url)) continue;
    out[id] = {
      id,
      dataURL: url,
      mimeType: String(file.mimeType || 'image/png').slice(0, 64),
      created: Number(file.created) || Date.now(),
    };
  }
  return out;
}

export function mergeBoardFiles(prev, next) {
  const out = { ...filesToMap(prev) };
  for (const [id, file] of Object.entries(filesToMap(next))) {
    if (!file || !isDurableImageRef(file.dataURL)) continue;
    out[id] = {
      id: String(file.id || id).slice(0, 64),
      dataURL: file.dataURL,
      mimeType: String(file.mimeType || 'image/png').slice(0, 64),
      created: Number(file.created) || Date.now(),
    };
  }
  return out;
}

export function prepareBoardScene(elements, localFiles, prevFiles) {
  const known = filesToMap(prevFiles);
  const files = mergeBoardFiles(prevFiles, localFiles);
  const els = (elements || []).filter((el) => el?.isDeleted || el?.type !== 'image' || files[el.fileId]);
  // The server merges incoming files over what it already stores and Excalidraw
  // file ids are content hashes, so only ship ids the server does not have yet;
  // steady-state scene packets stay element-only.
  const fresh = {};
  for (const [id, file] of Object.entries(files)) {
    if (!known[id]) fresh[id] = file;
  }
  return { elements: normalizeBoardElements(els, files), files: fresh };
}

export async function loadBoardLib() {
  if (Excalidraw) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;
    const [reactMod, reactDom, excal] = await Promise.all([
      import('https://esm.sh/react@18.3.1'),
      import('https://esm.sh/react-dom@18.3.1/client'),
      import(`https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VER}?deps=react@18.3.1,react-dom@18.3.1`),
    ]);
    React = reactMod.default || reactMod;
    createRoot = reactDom.createRoot || reactDom.default?.createRoot;
    Excalidraw = resolveExcalidrawExport(excal);
    if (!Excalidraw || !createRoot) throw new Error('Excalidraw export missing');
  })();
  try {
    await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

export function mountBoard(el, { isPresenter, elements, files, onChange }) {
  if (!el || !Excalidraw) return;
  latest = { isPresenter, elements, files, onChange, el };
  if (!root) {
    root = createRoot(el);
    seeded = false;
  }
  root.render(
    React.createElement(Excalidraw, {
      excalidrawAPI: (a) => {
        api = a;
        hydrateBoard();
      },
      viewModeEnabled: !isPresenter,
      zenModeEnabled: false,
      UIOptions: isPresenter
        ? undefined
        : { canvasActions: { loadScene: false, export: false, saveToActiveFile: false } },
      initialData: seeded
        ? undefined
        : {
          elements: normalizeBoardElements(elements, files),
          files: filesToMap(files),
          appState: {
            viewBackgroundColor: '#18181b',
            currentItemStrokeColor: '#e4e4e7',
          },
        },
      onChange: (els, appState, nextFiles) => {
        if (typeof window !== 'undefined') {
          const dbg = window.__boardDebug || (window.__boardDebug = { n: 0, gated: 0 });
          dbg.n += 1;
          dbg.last = {
            t: Date.now(),
            els: els?.length ?? 0,
            live: (els || []).filter((el) => el && !el.isDeleted).length,
            deleted: (els || []).filter((el) => el?.isDeleted).length,
            selected: Object.keys(appState?.selectedElementIds || {}).length,
            applyingRemote,
            isPresenter: latest.isPresenter,
          };
          if (applyingRemote || !latest.isPresenter) dbg.gated += 1;
        }
        if (applyingRemote || !latest.isPresenter) return;
        latest.onChange?.(els, nextFiles);
      },
    })
  );
  seeded = true;
  hydrateBoard();
  queueMicrotask(() => hydrateBoard());
}

export function applyBoardElements(elements, files) {
  latest.elements = elements;
  latest.files = files;
  hydrateBoard();
}

export function unmountBoard() {
  root?.unmount();
  root = null;
  api = null;
  seeded = false;
  applyingRemote = 0;
  latest = { isPresenter: false, elements: [], files: {}, onChange: null, el: null };
}
