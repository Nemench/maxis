import { contextBridge, ipcRenderer } from "electron";
import type { CreateOrderInput, OrderStatus, ProductInput } from "../../src/shared/types.js";

const api = {
  products: {
    list: () => ipcRenderer.invoke("products:list"),
    save: (input: ProductInput) => ipcRenderer.invoke("products:save", input),
    delete: (id: number) => ipcRenderer.invoke("products:delete", id)
  },
  orders: {
    create: (input: CreateOrderInput) => ipcRenderer.invoke("orders:create", input),
    list: (scope: "active" | "history" | "all") => ipcRenderer.invoke("orders:list", scope),
    get: (id: number) => ipcRenderer.invoke("orders:get", id),
    updateStatus: (id: number, status: OrderStatus) => ipcRenderer.invoke("orders:status", id, status),
    print: (id: number) => ipcRenderer.invoke("orders:print", id)
  }
};

contextBridge.exposeInMainWorld("kot", api);
