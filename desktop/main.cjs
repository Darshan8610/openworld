/**
 * Echoes of Blackwood Valley — desktop shell (Windows .exe via electron-builder).
 *
 * Serves the built game through a privileged custom scheme so ES modules,
 * workers and WASM load correctly from a packaged binary (file:// would be
 * blocked by Chromium's module CORS rules). All artwork/audio in the game is
 * generated procedurally — no bundled third-party media licenses.
 */
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 810,
    minWidth: 960,
    minHeight: 540,
    show: false,
    backgroundColor: '#05090b',
    autoHideMenuBar: true,
    title: 'Echoes of Blackwood Valley',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => win.webContents.focus());

  // Never let the game navigate away; external links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // F11 toggles fullscreen (classic desktop-game expectation).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  void win.loadURL('app://./index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    // Paths outside the build output never resolve.
    const target = path.normalize(path.join(DIST, pathname));
    if (!target.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
