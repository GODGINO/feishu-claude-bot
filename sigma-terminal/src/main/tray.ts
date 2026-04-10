import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;

export function createTray(window: BrowserWindow): void {
  trayWindow = window;

  const iconPath = path.join(__dirname, '..', '..', 'assets', 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  // Mark as template so macOS handles dark/light mode automatically
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Sigma Terminal');

  tray.on('click', (_event, bounds) => {
    if (!trayWindow) return;

    if (trayWindow.isVisible()) {
      trayWindow.hide();
      return;
    }

    // Position window below tray icon
    const { x, y } = bounds;
    const { width, height } = trayWindow.getBounds();
    const xPos = Math.round(x - width / 2);
    const yPos = Math.round(y);

    trayWindow.setBounds({ x: xPos, y: yPos, width, height });
    trayWindow.show();
    trayWindow.focus();
  });

  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          trayWindow?.show();
          trayWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Sigma Terminal',
        click: () => {
          trayWindow?.destroy();
          app.quit();
        },
      },
    ]);
    tray?.popUpContextMenu(contextMenu);
  });
}

export function updateTrayIcon(connected: boolean): void {
  if (!tray) return;
  // Use tooltip to indicate status (icon stays as template for menubar consistency)
  tray.setToolTip(connected ? 'Sigma Terminal — Connected' : 'Sigma Terminal — Disconnected');
}
