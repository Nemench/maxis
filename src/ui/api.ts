// Thin typed wrapper around the backend REST API. Every call goes through
// req()/download(), which attach the JWT and centrally handle a 401 (token
// missing/expired) by clearing it and forcing a reload back to the login screen.
import type { User, UserInput, Product, ProductInput, QuickCreateProductInput, Order, OrderItemInput, CreateOrderInput, OrderStatus, Department, DeptStatus, Supplier, WeighInBatch, WeighInBatchSummary, WeighInLine, WeighInLineInput, StockLocation, ProductStockRow, ItemSalesStat, ItemStockMovementStat, StatisticsOverview, MarginOverview, YieldEstimate, YieldEstimateInput, PendingYieldConversion, CrmContact, CrmContactInput, CrmContactDetail, CrmTag, CrmMessage, CrmAutomationRule, ConsentStatus, EmailSubscriber, CampaignPromo } from "../shared/types";
import { tokenStorage } from "./tokenStorage";

// The native Android app now live-loads its own server's page directly
// (see capacitor.config.ts's server.url) rather than bundling a copy of the
// web build, so its page origin already IS the API's origin — same as an
// ordinary browser tab. assetUrl() still builds a fully-qualified URL
// (rather than a relative path) because it's also used for standalone
// print documents opened in a separate blob/iframe context, where a
// relative path wouldn't resolve correctly.
const apiOrigin = window.location.origin;

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
    export: () => download("/products/export", `nemenchpos-products-${new Date().toISOString().slice(0, 10)}.csv`),
    getByBarcode: (code: string) => req<Product>("GET", `/products/barcode/${encodeURIComponent(code)}`),
    quickCreate: (data: QuickCreateProductInput) => req<Product>("POST", "/products/quick-create", data),
    missingCost: () => req<Product[]>("GET", "/products/missing-cost"),
    yieldEstimates: (rawProductId: number) => req<YieldEstimate[]>("GET", `/products/${rawProductId}/yield-estimates`),
    setYieldEstimates: (rawProductId: number, estimates: YieldEstimateInput[]) =>
      req<YieldEstimate[]>("PUT", `/products/${rawProductId}/yield-estimates`, estimates)
  },
  backup: {
    download: () => download("/backup", `nemenchpos-backup-${new Date().toISOString().slice(0, 10)}.json`),
    // Per-table restored row counts — the exact table set is server-driven
    // (KotDatabase.BACKUP_TABLES), so this stays loosely typed rather than
    // hard-coding a list here that could itself fall out of sync.
    restore: (data: object) => req<{ ok: boolean } & Record<string, number>>("POST", "/backup/restore", data)
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
      req<Order[]>("GET", `/reports?from=${from}&to=${to}`),
    emailReceipt: (id: number, to: string, html: string) => req<{ ok: boolean }>("POST", `/orders/${id}/email-receipt`, { to, html })
  },
  settings: {
    get: () => req<Record<string, string>>("GET", "/settings"),
    set: (data: Record<string, string>) => req<Record<string, string>>("PUT", "/settings", data),
    public: () => req<{ siteName: string; logoUrl: string; themeColor: string; vatRegistered: boolean; vatNumber: string; businessAddress: string; publicBaseUrl: string }>("GET", "/settings/public"),
    uploadLogo: (dataUrl: string) => req<{ logoUrl: string }>("POST", "/settings/logo", { dataUrl }),
    licenseStatus: () => req<{ licenseStatus: string; gracePeriodEndsAt: string | null }>("GET", "/settings/license-status"),
    testEmail: (to: string) => req<{ ok: boolean }>("POST", "/settings/email-test", { to })
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
    finalize: (batchId?: number) => req<{ batch: WeighInBatch; lines: WeighInLine[] }>("POST", "/weigh-in/finalize", batchId ? { batchId } : {}),
    pendingYields: (status: "pending" | "applied" | "dismissed" = "pending") =>
      req<PendingYieldConversion[]>("GET", `/weigh-in/pending-yields?status=${status}`),
    applyYield: (id: number, items: { subProductId: number; kg: number }[]) =>
      req<PendingYieldConversion>("POST", `/weigh-in/pending-yields/${id}/apply`, { items }),
    dismissYield: (id: number) => req<PendingYieldConversion>("POST", `/weigh-in/pending-yields/${id}/dismiss`)
  },
  statistics: {
    sales: (from: string, to: string) => req<ItemSalesStat[]>("GET", `/statistics/sales?from=${from}&to=${to}`),
    stockMovement: (from: string, to: string) => req<ItemStockMovementStat[]>("GET", `/statistics/stock-movement?from=${from}&to=${to}`),
    overview: (from: string, to: string) => req<StatisticsOverview>("GET", `/statistics/overview?from=${from}&to=${to}`),
    margins: (from: string, to: string, groupBy: "product" | "category" | "day") =>
      req<MarginOverview>("GET", `/statistics/margins?from=${from}&to=${to}&group_by=${groupBy}`)
  },
  crm: {
    contacts: (search?: string) => req<CrmContact[]>("GET", `/crm/contacts${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    contact: (id: string) => req<CrmContactDetail>("GET", `/crm/contacts/${id}`),
    updateContact: (id: string, data: CrmContactInput) => req<CrmContact>("PATCH", `/crm/contacts/${id}`, data),
    setConsent: (id: string, consentStatus: ConsentStatus) => req<CrmContact>("POST", `/crm/contacts/${id}/consent`, { consentStatus }),
    tags: () => req<CrmTag[]>("GET", "/crm/tags"),
    templates: () => req<{ name: string; category: "utility" | "marketing"; bodyTemplate: string }[]>("GET", "/crm/templates"),
    automationRules: () => req<CrmAutomationRule[]>("GET", "/crm/automation-rules"),
    setAutomationRule: (eventName: string, templateName: string, enabled: boolean) =>
      req<CrmAutomationRule>("PUT", `/crm/automation-rules/${eventName}`, { templateName, enabled }),
    send: (id: string, data: { freeformBody?: string; templateName?: string; templateParams?: unknown[] }) =>
      req<CrmMessage>("POST", `/crm/contacts/${id}/send`, data)
  },
  emailSubscribers: {
    list: () => req<EmailSubscriber[]>("GET", "/email-subscribers"),
    add: (email: string, name: string) => req<EmailSubscriber>("POST", "/email-subscribers", { email, name }),
    setStatus: (id: string, status: "subscribed" | "unsubscribed") => req<EmailSubscriber>("PATCH", `/email-subscribers/${id}`, { status }),
    remove: (id: string) => req<{ success: boolean }>("DELETE", `/email-subscribers/${id}`),
    uploadCampaignImage: (dataUrl: string) => req<{ imageUrl: string }>("POST", "/email-subscribers/campaign-image", { dataUrl }),
    sendCampaign: (subject: string, body: string, promo?: CampaignPromo) =>
      req<{ queued: number }>("POST", "/email-subscribers/send-campaign", { subject, body, promo })
  }
};
