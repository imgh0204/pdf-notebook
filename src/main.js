const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

// pdf.js loads CMaps and standard fonts with XHR, which Chromium blocks on file:// pages.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveAppFile(request) {
  const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
  const file = path.resolve(__dirname, relative);
  if (!file.startsWith(__dirname + path.sep)) return new Response('', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

let win = null;
let rendererReady = false;
let pendingFile = null;
let startupRead = Promise.resolve();
let lastDir = null;

/* ---------- settings ---------- */
let config = {};
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fsSync.writeFileSync(tmp, data);
  fsSync.renameSync(tmp, file);
}
function loadConfig() {
  try { config = JSON.parse(fsSync.readFileSync(configFile(), 'utf8')) || {}; } catch { config = {}; }
}
function saveConfig() {
  fsSync.mkdirSync(path.dirname(configFile()), { recursive: true });
  writeAtomic(configFile(), JSON.stringify(config, null, 2));
}

/* ---------- library on disk ----------
   The library is a plain folder the user picked. Sub-folders are the folder tree, and each
   document is the untouched original "name.pdf". Its editable notes, memo pads and thumbnail
   are in ".필기장/name.필기.json" and pasted images in ".필기장/name.필기-이미지.json":
   a hidden folder next to the PDF, so Explorer shows only PDFs. Older versions kept these
   files right next to the PDF; they are moved into the hidden folder when first seen. */
const META_DIR = '.필기장';
const NOTES_SUFFIX = '.필기.json';
const NOTES_VERSION = 2; // format of .필기.json written by this version
const IMAGES_SUFFIX = '.필기-이미지.json';
const stem = (pdf) => pdf.replace(/\.pdf$/i, '');
const docBase = (pdf) => path.basename(stem(pdf));
const metaDir = (pdf) => path.join(path.dirname(pdf), META_DIR);
const notesOf = (pdf) => path.join(metaDir(pdf), docBase(pdf) + NOTES_SUFFIX);
const imagesOf = (pdf) => path.join(metaDir(pdf), docBase(pdf) + IMAGES_SUFFIX);
const sidecarsOf = (pdf) => [notesOf(pdf), imagesOf(pdf)];
const legacyOf = (pdf) => [stem(pdf) + NOTES_SUFFIX, stem(pdf) + IMAGES_SUFFIX];
function ensureMetaSync(pdf) {
  const dir = metaDir(pdf);
  if (fsSync.existsSync(dir)) return;
  fsSync.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') execFile('attrib', ['+h', dir], { windowsHide: true }, () => {});
}
async function migrate(pdf) {
  const old = legacyOf(pdf), cur = sidecarsOf(pdf);
  for (let i = 0; i < old.length; i++) {
    if ((await exists(old[i])) && !(await exists(cur[i]))) { ensureMetaSync(pdf); await fs.rename(old[i], cur[i]); }
  }
}
async function moveSidecars(src, dst) {
  await migrate(src);
  const a = sidecarsOf(src), b = sidecarsOf(dst);
  for (let i = 0; i < a.length; i++) {
    if (await exists(a[i])) { ensureMetaSync(dst); await fs.rename(a[i], b[i]); }
  }
}
const exists = (p) => fs.access(p).then(() => true, () => false);
const codeErr = (code, message) => Object.assign(new Error(message || code), { code });
const nameCollator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function rootDir() {
  if (!config.root) throw codeErr('no-library');
  return path.resolve(config.root);
}
// Every path from the renderer is relative to the library and must stay inside it.
function abs(rel) {
  const root = rootDir();
  const p = path.resolve(root, rel || '.');
  if (p !== root && !p.startsWith(root + path.sep)) throw codeErr('bad-path');
  return p;
}
const toRel = (p) => path.relative(rootDir(), p).split(path.sep).join('/');
function relIfInLibrary(file) {
  if (!config.root) return null;
  const r = path.relative(path.resolve(config.root), path.resolve(file));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

function cleanName(name) {
  const n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!n || n.startsWith('.') || n.length > 120 || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) throw codeErr('bad-name');
  return n;
}
async function uniqueDoc(dir, base) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, (n === 1 ? base : `${base} (${n})`) + '.pdf');
    if (!(await exists(p)) && !(await Promise.all([...sidecarsOf(p), ...legacyOf(p)].map(exists))).some(Boolean)) return p;
  }
}
async function uniqueDir(dir, base) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, n === 1 ? base : `${base} (${n})`);
    if (!(await exists(p))) return p;
  }
}
const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();

async function scanDir(dir, rel) {
  const node = { name: rel ? path.basename(dir) : '', rel, folders: [], docs: [] };
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return node; }
  const names = new Set(entries.map((e) => e.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      node.folders.push(await scanDir(full, childRel));
    } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
      let mtime = 0, thumb = null;
      try { mtime = (await fs.stat(full)).mtimeMs; } catch {}
      if (legacyOf(full).some((f) => names.has(path.basename(f)))) { try { await migrate(full); } catch {} }
      const nf = notesOf(full);
      if (await exists(nf)) {
        try {
          mtime = Math.max(mtime, (await fs.stat(nf)).mtimeMs);
          thumb = JSON.parse(await fs.readFile(nf, 'utf8')).thumb || null;
        } catch {}
      }
      node.docs.push({ name: e.name.replace(/\.pdf$/i, ''), rel: childRel, dir: rel, mtime, thumb });
    }
  }
  node.folders.sort((a, b) => nameCollator.compare(a.name, b.name));
  node.docs.sort((a, b) => nameCollator.compare(a.name, b.name));
  return node;
}

// Notes are written synchronously so writes land in the order they were sent,
// including the final flush when the window closes. `seq` drops a late, older write.
const lastSeq = new Map();
function writeNotesSync(rel, notes) {
  const pdf = abs(rel);
  if (!fsSync.existsSync(pdf)) throw codeErr('ENOENT');
  const file = notesOf(pdf);
  if (notes.seq != null) {
    if (notes.seq <= (lastSeq.get(file) || 0)) return;
    lastSeq.set(file, notes.seq);
  }
  ensureMetaSync(pdf);
  let old = {};
  try { old = JSON.parse(fsSync.readFileSync(file, 'utf8')) || {}; } catch (e) {
    // An existing file we cannot read right now (held by antivirus or sync, say) must not be replaced by a
    // partial write such as a thumbnail-only update, which would leave the notes empty.
    const partial = notes.pages === undefined || notes.memos === undefined;
    if (partial && e.code !== 'ENOENT') throw codeErr('EBUSY');
  }
  // Fields a newer version wrote are kept as they are (...old), so going back to an older app loses nothing.
  const out = {
    ...old,
    version: Math.max(NOTES_VERSION, old.version || 0),
    pages: notes.pages !== undefined ? notes.pages : (old.pages || []),
    memos: notes.memos !== undefined ? notes.memos : (old.memos || []),
    thumb: notes.thumb !== undefined ? notes.thumb : (old.thumb || null),
  };
  writeAtomic(file, JSON.stringify(out));
  if (notes.images !== undefined) {
    const imf = imagesOf(pdf);
    if (notes.images && Object.keys(notes.images).length) writeAtomic(imf, JSON.stringify(notes.images));
    else { try { fsSync.unlinkSync(imf); } catch {} }
  }
}

async function importFile(src, destRel) {
  let base;
  try { base = cleanName(path.basename(src).replace(/\.pdf$/i, '')); } catch { base = '문서'; }
  const dst = await uniqueDoc(abs(destRel), base);
  await fs.copyFile(src, dst);
  // A document copied from another library keeps its notes and images.
  const from = sidecarsOf(src), old = legacyOf(src), to = sidecarsOf(dst);
  for (let i = 0; i < to.length; i++) {
    const f = (await exists(from[i])) ? from[i] : (await exists(old[i])) ? old[i] : null;
    if (f) { ensureMetaSync(dst); await fs.copyFile(f, to[i]); }
  }
  return toRel(dst);
}

/* ---------- IPC ---------- */
// Library calls return {ok, value} or {ok:false, code} so the renderer can tell errors apart.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, code: e.code || 'failed', message: e.message }; }
  });
}

handle('lib:info', () => {
  let ok = false;
  if (config.root) { try { ok = fsSync.statSync(config.root).isDirectory(); } catch {} }
  return { root: config.root || null, exists: ok, defaultRoot: path.join(app.getPath('documents'), 'PDF 필기장') };
});

handle('lib:choose-root', async (current) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '필기를 보관할 폴더 선택',
    defaultPath: current || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
});

handle('lib:set-root', async (dir) => {
  const root = path.resolve(dir);
  await fs.mkdir(root, { recursive: true });
  const probe = path.join(root, '.pdf-notebook-write-test');
  await fs.writeFile(probe, '');
  await fs.unlink(probe);
  config.root = root;
  saveConfig();
  const entries = (await fs.readdir(root)).filter((n) => !n.startsWith('.'));
  return { root, empty: entries.length === 0 };
});

handle('lib:scan', () => scanDir(rootDir(), ''));

handle('lib:mkdir', async (parentRel, name) => {
  const dir = path.join(abs(parentRel), cleanName(name));
  if (await exists(dir)) throw codeErr('exists');
  await fs.mkdir(dir);
  return toRel(dir);
});

handle('lib:rename', async (rel, isDoc, newName) => {
  if (!rel) throw codeErr('bad-path');
  const src = abs(rel);
  const n = cleanName(newName);
  const dst = path.join(path.dirname(src), isDoc ? n + '.pdf' : n);
  if (dst === src) return rel;
  if (!sameFile(dst, src) && ((await exists(dst)) || (isDoc && (await exists(notesOf(dst)))))) throw codeErr('exists');
  await fs.rename(src, dst);
  if (isDoc) await moveSidecars(src, dst);
  return toRel(dst);
});

handle('lib:move', async (rel, isDoc, destRel) => {
  if (!rel) throw codeErr('bad-path');
  const src = abs(rel);
  const destDir = abs(destRel);
  if (path.dirname(src) === destDir) return rel;
  if (!isDoc && (destDir === src || destDir.startsWith(src + path.sep))) throw codeErr('into-self');
  const dst = isDoc
    ? await uniqueDoc(destDir, path.basename(src).replace(/\.pdf$/i, ''))
    : await uniqueDir(destDir, path.basename(src));
  await fs.rename(src, dst);
  if (isDoc) await moveSidecars(src, dst);
  return toRel(dst);
});

handle('lib:trash', async (rel, isDoc) => {
  if (!rel) throw codeErr('bad-path');
  const src = abs(rel);
  if (isDoc) await migrate(src);
  await shell.trashItem(src);
  if (isDoc) for (const f of sidecarsOf(src)) if (await exists(f)) await shell.trashItem(f);
});

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
// PDFs are copied here; images go back to the page, which turns them into PDF pages.
handle('lib:import-dialog', async (destRel) => {
  abs(destRel);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'PDF·이미지 가져오기',
    defaultPath: lastDir || app.getPath('documents'),
    filters: [
      { name: 'PDF·이미지', extensions: ['pdf', ...IMAGE_EXTS] },
      { name: 'PDF 문서', extensions: ['pdf'] },
      { name: '이미지', extensions: IMAGE_EXTS },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled) return { rels: [], images: [] };
  const rels = [], images = [];
  for (const f of filePaths) {
    if (/\.pdf$/i.test(f)) rels.push(await importFile(f, destRel));
    else images.push({ name: path.basename(f), data: await fs.readFile(f) });
  }
  if (filePaths[0]) lastDir = path.dirname(filePaths[0]);
  return { rels, images };
});

handle('lib:import-data', async (destRel, filename, data, notes) => {
  let base;
  try { base = cleanName(String(filename).replace(/\.pdf$/i, '')); } catch { base = '문서'; }
  const dst = await uniqueDoc(abs(destRel), base);
  await fs.writeFile(dst, Buffer.from(data));
  const rel = toRel(dst);
  if (notes) writeNotesSync(rel, notes);
  return rel;
});

// Reads a JSON sidecar; a damaged one is set aside instead of being overwritten by autosave.
async function readSidecar(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { value: null }; throw e; }
  try { return { value: JSON.parse(text) }; } catch {
    await fs.rename(file, `${file}.손상됨-${Date.now()}`);
    return { value: null, recovered: true };
  }
}

handle('lib:read', async (rel) => {
  const pdf = abs(rel);
  const data = await fs.readFile(pdf);
  await migrate(pdf);
  const notes = await readSidecar(notesOf(pdf));
  const images = await readSidecar(imagesOf(pdf));
  return { data, notes: notes.value, images: images.value || {}, recovered: !!(notes.recovered || images.recovered) };
});

handle('lib:write-notes', (rel, notes) => writeNotesSync(rel, notes));
ipcMain.on('lib:write-notes-sync', (event, rel, notes) => {
  try { writeNotesSync(rel, notes); event.returnValue = true; } catch { event.returnValue = false; }
});

handle('lib:reveal', async (rel, isDoc) => {
  const p = abs(rel);
  if (isDoc) shell.showItemInFolder(p);
  else { const err = await shell.openPath(p); if (err) throw codeErr('failed', err); }
});

/* Images go through the page's Clipboard API; plain text is read here as a fallback. */
ipcMain.handle('clip:read-text', () => clipboard.readText());
ipcMain.handle('clip:write-text', (_event, text) => { clipboard.writeText(String(text)); });

ipcMain.handle('get-initial-file', async () => {
  await startupRead;
  rendererReady = true;
  const file = pendingFile;
  pendingFile = null;
  return file;
});

ipcMain.handle('save-pdf', async (_event, filename, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'PDF로 내보내기',
    defaultPath: path.join(lastDir || app.getPath('documents'), path.basename(filename)),
    filters: [{ name: 'PDF 문서', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { status: 'canceled' };
  try {
    await fs.writeFile(filePath, data);
  } catch (e) {
    return { status: 'failed', message: e.message };
  }
  lastDir = path.dirname(filePath);
  return { status: 'saved' };
});

/* ---------- opening files from Windows ---------- */
// Windows passes the PDF as a command-line argument, for "open with" and for a drop on the icon.
function pdfFromArgs(argv, cwd) {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
  return arg ? path.resolve(cwd, arg) : null;
}

async function deliverFile(filePath) {
  let file;
  const rel = relIfInLibrary(filePath);
  if (rel && fsSync.existsSync(filePath)) {
    file = { rel };
  } else {
    try {
      file = { name: path.basename(filePath), data: await fs.readFile(filePath) };
    } catch (e) {
      dialog.showErrorBox('PDF 필기장', `파일을 열지 못했어요.\n${filePath}\n\n${e.message}`);
      return;
    }
    lastDir = path.dirname(filePath);
  }
  if (rendererReady && win) win.webContents.send('open-file', file);
  else pendingFile = file;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'PDF 필기장',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false, // the spellchecker downloads dictionaries from the network
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Library documents save on their own; only a PDF opened from outside the library can block closing.
  win.webContents.on('will-prevent-unload', (e) => {
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'PDF 필기장',
      message: '라이브러리에 추가하지 않은 필기가 있어요.',
      detail: '창을 닫으면 지금 필기는 사라져요. 계속할까요?',
      buttons: ['저장하지 않고 닫기', '취소'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) e.preventDefault(); // allow the close
  });
  win.on('closed', () => { win = null; });
  win.loadURL('app://local/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const filePath = pdfFromArgs(argv, cwd);
    if (filePath) deliverFile(filePath);
  });

  app.whenReady().then(() => {
    loadConfig();
    protocol.handle('app', serveAppFile);
    Menu.setApplicationMenu(null); // also removes Ctrl+R, which would wipe unsaved notes
    const filePath = pdfFromArgs(process.argv, process.cwd());
    if (filePath) startupRead = deliverFile(filePath);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
