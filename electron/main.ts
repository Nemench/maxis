import { app, Tray, Menu, shell, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single instance — if already running, focus it
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
let tray: Tray | null = null;

app.whenReady().then(async () => {
  // Point database to persistent user data folder
  process.env.DATA_DIR = app.getPath("userData");
  process.env.NODE_ENV = "production";
  process.env.PORT = String(PORT);

  // Start the Express server — variable path so bundler doesn't try to resolve it
  const serverEntry = path.join(__dirname, "../server-dist/index.cjs");
  await import(serverEntry);

  // Build tray icon
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "logo.jpg")
    : path.join(__dirname, "../public/logo.jpg");

  const img = nativeImage.createFromPath(iconPath);
  const icon = img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip(`MAXIS KOT  •  http://localhost:${PORT}`);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open MAXIS",
        click: () => shell.openExternal(`http://localhost:${PORT}`),
      },
      { type: "separator" },
      {
        label: "Exit",
        click: () => {
          tray?.destroy();
          app.quit();
        },
      },
    ])
  );

  // Left-click tray → open browser
  tray.on("click", () => shell.openExternal(`http://localhost:${PORT}`));

  // Open browser automatically on launch
  shell.openExternal(`http://localhost:${PORT}`);
});

// Keep alive even with no windows open (it's a tray-only app)
app.on("window-all-closed", () => {});
