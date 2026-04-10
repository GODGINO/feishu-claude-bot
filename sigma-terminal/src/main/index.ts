import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import * as path from 'path';
import { createTray, updateTrayIcon } from './tray';
import { connect, disconnect, getState, onStateChange, type ConnectionState } from './relay-client';
import { executeCommand } from './executor';
import Store from 'electron-store';

const store = new Store<{ sessions: Array<{ key: string; name: string; type: string }> }>({
  defaults: { sessions: [] },
});

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Renderer files are in src/renderer/ (not compiled), resolve from project root
  win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

  // Hide instead of close
  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  // Hide when losing focus
  win.on('blur', () => {
    win.hide();
  });

  return win;
}

app.whenReady().then(() => {
  // Pure menubar app — hide from Dock
  app.dock?.hide();

  mainWindow = createWindow();

  createTray(mainWindow);

  // Forward state changes to renderer
  onStateChange((state: ConnectionState) => {
    mainWindow?.webContents.send('stateChanged', state);
    updateTrayIcon(state.connected);
  });

  // ── IPC handlers ──

  ipcMain.handle('getState', () => getState());

  ipcMain.handle('getSessions', () => store.get('sessions'));

  ipcMain.handle('saveSessions', (_e, sessions) => {
    store.set('sessions', sessions);
  });

  ipcMain.handle('connect', (_e, relayUrl: string, sessionKeys: string[]) => {
    connect(relayUrl, sessionKeys, executeCommand);
    return getState();
  });

  ipcMain.handle('disconnect', () => {
    disconnect();
    return getState();
  });

  ipcMain.handle('resolveSessionName', async (_e, relayUrl: string, key: string) => {
    try {
      const res = await fetch(`${relayUrl}/api/session-names?keys=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const data = await res.json() as Record<string, any>;
      return data[key] || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('notify', (_e, title: string, body: string) => {
    new Notification({ title, body }).show();
  });
});

app.on('window-all-closed', () => {
  // Keep app running as tray app — do nothing
});
