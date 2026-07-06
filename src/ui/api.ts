// Thin typed wrapper around the backend REST API. Every call goes through
// req()/download(), which attach the JWT and centrally handle a 401 (token
// missing/expired) by clearing it and forcing a reload back to the login screen.
import { Capacitor } from "@capacitor/core";
import type { User, UserInput, Product, ProductInput, QuickCreateProductInput, Order, OrderItemInput, CreateOrderInput, OrderStatus, Department, DeptStatus, Supplier, WeighInBatch, WeighInBatchSummary, WeighInLine, WeighInLineInput, StockLocation, ProductStockRow, ItemSalesStat, ItemStockMovementStat, StatisticsOverview, MarginOverview } from "../shared/types";
import { tokenStorage } from "./tokenStorage";
import { NATIVE_SERVER_URL } from "../shared/nativeServer";

// The native app bundles the web build locally, so its own page origin is
// Capacitor's internal one, not this server's — every request needs an
// absolute URL there. In the browser this just resolves to the page's own
// origin (a no-op relative to the previous same-origin requests) — always
// fully absolute rather than relative, since assetUrl() below is also used
// to build image URLs for standalone print documents (opened in a separate
// blob/iframe context, where a relative path wouldn't resolve correctly).
const apiOrigin = Capacitor.isNativePlatform() ? NATIVE_SERVER_URL : window.location.origin;

// Resolves a server-relative path (e.g. an uploaded logo's /uploads/... URL)
// to a fully-qualified URL loadable from wherever the app is currently running.
export function assetUrl(path: string): string {
  return `${apiOrigin}${path}`;
}

// JSON request/response helper used by nearly every endpoint below.
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStorage.get();
  const res = await fetch(`${apiOrigin}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    tokenStorage.clear();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// Fetches a binary response (CSV/JSON export) and triggers a browser
// download via a throwaway object URL + anchor click.
async function download(path: string, filename: string): Promise<void> {
  const token = tokenStorage.get();
  const res = await fetch(`${apiOrigin}/api${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (res.status === 401) { tokenStorage.clear(); window.location.reload(); return; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  auth: {
    login: (name: string, pin: string) => req<{ token: string; user: User }>("POST", "/auth/login", { name, pin }),
    me: () => req<User>("GET", "/auth/me"),
    setThemeMode: (themeMode: "light" | "dark") =>
      req<{ token: string; user: User }>("PATCH", "/auth/theme-mode", { themeMode }),
    verifyPin: (pin: string) => req<{ ok: boolean }>("POST", "/auth/verify-pin", { pin })
  },
  users: {
    list: () => req<User[]>("GET", "/users"),
    create: (data: UserInput) => req<User>("POST", "/users", data),
    update: (id: number, data: Partial<UserInput & { isActive: number }>) => req<User>("PATCH", `/users/${id}`, data)
  },
  products: {
    list: () => req<Product[]>("GET", "/products"),
    save: (data: ProductInput) =>
      data.id ? req<Product>("PUT", `/products/${data.id}`, data) : req<Product>("POST", "/products", data),
    delete: (id: number) => req<void>("DELETE", `/products/${id}`),
    import: (csv: string) => req<{ imported: number; errors: string[] }>("POST", "/products/import", { csv }),
    export: () => download("/products/export", `maxis-products-${new Date().toISOString().slice(0, 10)}.csv`),
    getByBarcode: (code: string) => req<Product>("GET", `/products/barcode/${encodeURIComponent(code)}`),
    quickCreate: (data: QuickCreateProductInput) => req<Product>("POST", "/products/quick-create", data),
    missingCost: () => req<Product[]>("GET", "/products/missing-cost")
  },
  backup: {
    download: () => download("/backup", `maxis-backup-${new Date().toISOString().slice(0, 10)}.json`),
    restore: (data: object) => req<{ ok: boolean; products: number; users: number; orders: number }>("POST", "/backup/restore", data)
  },
  orders: {
    list: (scope: string) => req<Order[]>("GET", `/orders?scope=${scope}`),
    create: (data: CreateOrderInput) => req<Order>("POST", "/orders", data),
    get: (id: number) => req<Order>("GET", `/orders/${id}`),
    addItem: (id: number, item: OrderItemInput) => req<Order>("POST", `/orders/${id}/items`, item),
    updateStatus: (id: number, status: OrderStatus) => req<Order>("PATCH", `/orders/${id}/status`, { status }),
    updateDeptStatus: (id: number, department: Department, status: DeptStatus) =>
      req<Order>("PATCH", `/orders/${id}/dept-status`, { department, status }),
    export: (from: string, to: string) =>
      req<Order[]>("GET", `/reports?from=${from}&to=${to}`)
  },
  settings: {
    get: () => req<Record<string, string>>("GET", "/settings"),
    set: (data: Record<string, string>) => req<Record<string, string>>("PUT", "/settings", data),
    public: () => req<{ siteName: string; logoUrl: string; themeColor: string; vatRegistered: boolean; vatNumber: string; businessAddress: string }>("GET", "/settings/public"),
    uploadLogo: (dataUrl: string) => req<{ logoUrl: string }>("POST", "/settings/logo", { dataUrl })
  },
  printers: {
    list: () => req<string[]>("GET", "/printers")
  },
  print: (printerName: string, html: string) =>
    req<{ ok: boolean }>("POST", "/print", { printerName, html }),
  stock: {
    list: () => req<Product[]>("GET", "/stock"),
    low: () => req<Product[]>("GET", "/stock/low"),
    forLocation: (locationId: number) => req<ProductStockRow[]>("GET", `/stock/location/${locationId}`),
    // Records what was physically counted — the server computes the delta
    // from the stored quantity itself, there's no "set to X" call anywhere.
    recordCount: (productId: number, locationId: number, countedQty: number) =>
      req<ProductStockRow>("PUT", `/stock/${productId}`, { locationId, countedQty }),
    locations: {
      list: () => req<StockLocation[]>("GET", "/stock/locations"),
      create: (name: string) => req<StockLocation>("POST", "/stock/locations", { name }),
      deactivate: (id: number) => req<{ success: boolean }>("DELETE", `/stock/locations/${id}`)
    }
  },
  suppliers: {
    list: () => req<Supplier[]>("GET", "/suppliers"),
    create: (name: string) => req<Supplier>("POST", "/suppliers", { name })
  },
  weighIn: {
    current: () => req<{ batch: WeighInBatch | null; lines: WeighInLine[] }>("GET", "/weigh-in/current"),
    list: (from?: string, to?: string) => req<WeighInBatchSummary[]>("GET", from && to ? `/weigh-in?from=${from}&to=${to}` : "/weigh-in"),
    get: (batchId: number) => req<{ batch: WeighInBatch; lines: WeighInLine[] }>("GET", `/weigh-in/${batchId}`),
    addLine: (data: WeighInLineInput) => req<WeighInLine>("POST", "/weigh-in/lines", data),
    updateLine: (id: number, data: WeighInLineInput) => req<WeighInLine>("PUT", `/weigh-in/lines/${id}`, data),
    deleteLine: (id: number) => req<{ success: boolean }>("DELETE", `/weigh-in/lines/${id}`),
    finalize: (batchId?: number) => req<{ batch: WeighInBatch; lines: WeighInLine[] }>("POST", "/weigh-in/finalize", batchId ? { batchId } : {})
  },
  statistics: {
    sales: (from: string, to: string) => req<ItemSalesStat[]>("GET", `/statistics/sales?from=${from}&to=${to}`),
    stockMovement: (from: string, to: string) => req<ItemStockMovementStat[]>("GET", `/statistics/stock-movement?from=${from}&to=${to}`),
    overview: (from: string, to: string) => req<StatisticsOverview>("GET", `/statistics/overview?from=${from}&to=${to}`),
    margins: (from: string, to: string, groupBy: "product" | "category" | "day") =>
      req<MarginOverview>("GET", `/statistics/margins?from=${from}&to=${to}&group_by=${groupBy}`)
  }
};
