const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

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

// Windows passes the PDF as a command-line argument, for "open with" and for a drop on the icon.
function pdfFromArgs(argv, cwd) {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
  return arg ? path.resolve(cwd, arg) : null;
}

async function deliverFile(filePath) {
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (e) {
    dialog.showErrorBox('PDF 필기장', `파일을 열지 못했어요.\n${filePath}\n\n${e.message}`);
    return;
  }
  lastDir = path.dirname(filePath);
  const file = { name: path.basename(filePath), data };
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
  win.webContents.on('will-prevent-unload', (e) => {
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'PDF 필기장',
      message: '저장하지 않은 필기가 있어요.',
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

ipcMain.handle('get-initial-file', async () => {
  await startupRead;
  rendererReady = true;
  const file = pendingFile;
  pendingFile = null;
  return file;
});

ipcMain.handle('save-pdf', async (_event, filename, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '다른 이름으로 저장',
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

ipcMain.handle('confirm-discard', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'PDF 필기장',
    message: '저장하지 않은 필기가 있어요.',
    detail: '다른 PDF를 열면 지금 필기는 사라져요. 계속할까요?',
    buttons: ['저장하지 않고 열기', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
});

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
    protocol.handle('app', serveAppFile);
    Menu.setApplicationMenu(null); // also removes Ctrl+R, which would wipe unsaved notes
    const filePath = pdfFromArgs(process.argv, process.cwd());
    if (filePath) startupRead = deliverFile(filePath);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
