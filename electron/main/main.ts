import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KotDatabase } from "./database.js";
import { openPrintPreview } from "./print.js";
import type { CreateOrderInput, OrderStatus, ProductInput } from "../../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new KotDatabase();

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Butcher KOT",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged && process.env.NODE_ENV !== "production") {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../../dist/index.html"));
  }
}

function registerIpc() {
  ipcMain.handle("products:list", () => db.listProducts());
  ipcMain.handle("products:save", (_event, input: ProductInput) => db.upsertProduct(input));
  ipcMain.handle("products:delete", (_event, id: number) => db.deleteProduct(id));

  ipcMain.handle("orders:create", (_event, input: CreateOrderInput) => db.createOrder(input));
  ipcMain.handle("orders:list", (_event, scope: "active" | "history" | "all") => db.listOrders(scope));
  ipcMain.handle("orders:get", (_event, id: number) => db.getOrder(id));
  ipcMain.handle("orders:status", (_event, id: number, status: OrderStatus) => db.updateOrderStatus(id, status));
  ipcMain.handle("orders:print", (_event, id: number) => openPrintPreview(db.getOrder(id)));
}

app.whenReady().then(async () => {
  await db.initialize();
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
