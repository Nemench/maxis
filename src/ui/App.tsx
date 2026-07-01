// Single-file React SPA for the whole client UI. One component per screen/
// panel (Login, OrderEntry, Queue, HistoryView, Products, StockTakePanel,
// WeighInPanel, UsersPanel, SettingsPanel, ReportsPanel), switched by the
// `tab` state in MainApp and gated per-role both here (nav visibility) and
// on the server (route middleware) — client-side gating is a UX nicety,
// never the actual security boundary. Printing (buildReceiptHtml /
// buildWeighInSummaryHtml / printHtml) lives at the bottom as plain
// functions, not components, since they build a full standalone HTML
// document string for a separate print tab/iframe rather than rendering
// into this app's own DOM.
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import {
  BarChart2,
  ClipboardList,
  FileDown,
  History,
  LogOut,
  Package,
  Plus,
  Printer,
  Save,
  ScanLine,
  Scissors,
  Settings,
  Trash2,
  Users,
  Weight,
  X
} from "lucide-react";
import { appSettings } from "../shared/settings";
import type {
  CreateOrderInput,
  DeliveryAddress,
  Department,
  DeptStatus,
  Grade,
  Order,
  OrderItemInput,
  Product,
  ProductInput,
  Supplier,
  User,
  UserInput,
  WeighInBatchSummary,
  WeighInLine
} from "../shared/types";
import { api } from "./api";
import { applyTheme, deriveShades } from "./theme";
import { tokenStorage } from "./tokenStorage";

type Tab = "orders" | "queue" | "history" | "products" | "users" | "settings" | "reports" | "stockTake" | "weighIn";

const deptStatusFlow: DeptStatus[] = ["New", "Received", "Ready", "Done"];
const emptyLine: OrderItemInput = { productId: null, name: "", kg: null, quantity: null, notes: "", unitPrice: null, lineTotal: null, department: "counter" };
const EMPTY_PRODUCT: ProductInput = { name: "", category: "", unitDefault: "kg", pricePerUnit: null, prepNotes: "", department: "counter", lowStockThreshold: null, barcode: null };

const currency = new Intl.NumberFormat(appSettings.locale, { style: "currency", currency: appSettings.currency });

// ── Auth wrapper ──────────────────────────────────────────────────────────────

// Updates the browser tab title/favicon to match the admin-configured branding.
function applyBranding(siteName: string, logoUrl: string) {
  document.title = siteName || "MAXIS";
  document.querySelector('link[rel="icon"]')?.setAttribute("href", logoUrl || "/logo.jpg");
}

// Plain module cache so receipt-building functions (outside the React tree) can
// read live branding without threading it through every print call site.
let receiptBranding = { siteName: "MAXIS", logoUrl: "", themeColor: "" };
function setReceiptBranding(patch: Partial<typeof receiptBranding>) {
  receiptBranding = { ...receiptBranding, ...patch };
}

// Set while the native app's in-app print preview overlay (see printHtml)
// is open, so the hardware back-button handler below can close it instead
// of minimizing/exiting the app. Module-level because printHtml is a plain
// function, not a component, and can be called from many places.
let closeActivePrintPreview: (() => void) | null = null;

// Top-level component: resolves the boot/login/logged-in state before
// deciding what to render, and applies branding for both the login screen
// and the logged-in app.
export function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [branding, setBranding] = useState({ siteName: "MAXIS", logoUrl: "" });

  // Validate any stored token against the server on load, rather than
  // trusting it blindly — also picks up server-side role changes.
  useEffect(() => {
    const token = tokenStorage.get();
    if (!token) { setBooting(false); return; }
    api.auth.me()
      .then(setCurrentUser)
      .catch(() => tokenStorage.clear())
      .finally(() => setBooting(false));
  }, []);

  // Branding/theme apply on boot — works whether logged in or not, so the login screen is branded too
  useEffect(() => {
    api.settings.public().then((s) => {
      setBranding({ siteName: s.siteName, logoUrl: s.logoUrl });
      applyBranding(s.siteName, s.logoUrl);
      setReceiptBranding({ siteName: s.siteName, logoUrl: s.logoUrl, themeColor: s.themeColor });
      if (s.themeColor) applyTheme(s.themeColor);
    }).catch(() => undefined);
  }, []);

  // In the native Android app, the hardware/gesture back button otherwise
  // does nothing useful for content opened outside normal page navigation
  // (e.g. the print preview overlay) — without this, the only way out was
  // force-closing the app. Close the preview if one is open; otherwise
  // background the app rather than letting Android exit it outright.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = CapacitorApp.addListener("backButton", () => {
      if (closeActivePrintPreview) { closeActivePrintPreview(); return; }
      void CapacitorApp.minimizeApp();
    });
    return () => { void handle.then((h) => h.remove()); };
  }, []);

  const logout = () => { tokenStorage.clear(); setCurrentUser(null); };

  if (booting) return <div className="boot-screen"><Scissors size={32} /></div>;
  if (!currentUser) return <LoginScreen onLogin={setCurrentUser} branding={branding} />;
  return <MainApp currentUser={currentUser} onLogout={logout} branding={branding} onBrandingChange={setBranding} />;
}

// ── Login ─────────────────────────────────────────────────────────────────────

// Name + PIN login form, shown when there's no valid session.
function LoginScreen({ onLogin, branding }: { onLogin: (user: User) => void; branding: { siteName: string; logoUrl: string } }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const { token, user } = await api.auth.login(name, pin);
      tokenStorage.set(token);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="login-screen">
      <form className="login-card panel" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">
          <img src={branding.logoUrl || "/logo.jpg"} alt={branding.siteName} className="login-logo" />
          <h1>{branding.siteName}</h1>
        </div>
        <label>Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label>PIN
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>
        {error && <div className="form-message">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

// The logged-in shell: sidebar nav (gated per role) + whichever panel the
// current tab selects. Owns the shared data (products/orders) that multiple
// panels need, refreshed on mount and lightly polled while on the Queue tab.
function MainApp({ currentUser, onLogout, branding, onBrandingChange }: { currentUser: User; onLogout: () => void; branding: { siteName: string; logoUrl: string }; onBrandingChange: (b: { siteName: string; logoUrl: string }) => void }) {
  // stock_taker gets a completely separate, minimal nav (Stock Take +
  // Weigh-In only) — everything else below the ternary is for other roles.
  const isStockTaker = currentUser.role === "stock_taker";
  const [tab, setTab] = useState<Tab>(isStockTaker ? "stockTake" : currentUser.role === "kitchen" || currentUser.role === "counter" ? "queue" : "orders");
  const [products, setProducts] = useState<Product[]>([]);
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [autoPrint, setAutoPrint] = useState(false);
  const [printStyle, setPrintStyle] = useState("thermal");
  const [printerMap, setPrinterMap] = useState({ kitchen: "", counter: "", master: "" });
  const [lowStockCount, setLowStockCount] = useState(0);

  // Full refresh — products + orders. Only on mount and after mutations.
  const refresh = async () => {
    const [productList, activeList, lowStock] = await Promise.all([
      api.products.list(),
      api.orders.list("active"),
      api.stock.low().catch(() => []),
    ]);
    setProducts(productList);
    setActiveOrders(activeList);
    setLowStockCount(lowStock.length);
  };

  // Lightweight poll — only active orders every 5s (products & history excluded)
  const pollActive = async () => {
    const activeList = await api.orders.list("active");
    setActiveOrders(activeList);
  };

  useEffect(() => {
    api.settings.get().then((s) => {
      setAutoPrint(s.autoPrint === "true");
      setPrintStyle(s.printStyle ?? "thermal");
      setPrinterMap({ kitchen: s.kitchenPrinter ?? "", counter: s.counterPrinter ?? "", master: s.masterPrinter ?? "" });
    }).catch(() => undefined);
  }, []);

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch history only when the user actually opens the history tab
  useEffect(() => {
    if (tab === "history") {
      api.orders.list("history").then(setHistoryOrders).catch(() => undefined);
    }
  }, [tab]);

  useEffect(() => {
    const id = setInterval(() => void pollActive(), 5000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 2500);
  };

  // Confirmed because an accidental tap (easy on the compact mobile/app nav)
  // would otherwise drop the user straight back to the login screen mid-task.
  const confirmLogout = () => {
    if (window.confirm("Sign out?")) onLogout();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={branding.logoUrl || "/logo.jpg"} alt={branding.siteName} className="brand-logo" />
          <div>
            <strong>{branding.siteName}</strong>
            <span>{currentUser.name} · {{ admin: "Admin", cashier: "Cashier", master_cashier: "Master Cashier", kitchen: "Kitchen", counter: "Counter", stock_taker: "Stock Taker" }[currentUser.role]}</span>
          </div>
        </div>
        <nav>
          {isStockTaker ? (
            <>
              <button className={tab === "stockTake" ? "active" : ""} onClick={() => setTab("stockTake")}><Package size={18} /><span>Stock Take</span></button>
              <button className={tab === "weighIn" ? "active" : ""} onClick={() => setTab("weighIn")}><Weight size={18} /><span>Weigh-In</span></button>
            </>
          ) : (
            <>
              {(currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier") && (
                <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}><Plus size={18} /><span>New</span></button>
              )}
              <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}><ClipboardList size={18} /><span>Queue</span></button>
              <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={18} /><span>History</span></button>
              {currentUser.role === "admin" && (
                <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>
                  <Package size={18} /><span>Stock</span>
                  {lowStockCount > 0 && <span className="badge-count">{lowStockCount}</span>}
                </button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "stockTake" ? "active" : ""} onClick={() => setTab("stockTake")}><Package size={18} /><span>Stock Take</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "weighIn" ? "active" : ""} onClick={() => setTab("weighIn")}><Weight size={18} /><span>Weigh-In</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={18} /><span>Users</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={18} /><span>Settings</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}><BarChart2 size={18} /><span>Reports</span></button>
              )}
            </>
          )}
          {/* Sign out lives in nav itself (not just .sidebar-footer below) so it's
              never hidden — .sidebar-footer is dropped by the ≤920px responsive
              breakpoint, which would otherwise leave mobile/app users with no way
              to log out. nav is never hidden at any screen size. */}
          <button className="nav-signout" onClick={confirmLogout}><LogOut size={18} /><span>Sign out</span></button>
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{tabTitle(tab)}</h1>
            <p>{tabSubtitle(tab)}</p>
          </div>
        </header>

        {message && <div className="toast">{message}</div>}

        {tab === "orders" && (
          <OrderEntry
            products={products}
            currentUser={currentUser}
            autoPrint={autoPrint}
            printStyle={printStyle}
            printerMap={printerMap}
            onCreated={async (order) => { notify(`Created ${order.ticketNumber}`); await refresh(); setTab("queue"); }}
          />
        )}
        {tab === "queue" && <Queue orders={activeOrders} currentUser={currentUser} onChanged={refresh} printStyle={printStyle} printerMap={printerMap} />}
        {tab === "history" && <HistoryView orders={historyOrders} printStyle={printStyle} printerMap={printerMap} />}
        {tab === "products" && currentUser.role === "admin" && <Products products={products} onChanged={refresh} />}
        {tab === "stockTake" && (currentUser.role === "admin" || isStockTaker) && <StockTakePanel products={products} onChanged={refresh} />}
        {tab === "weighIn" && (currentUser.role === "admin" || isStockTaker) && <WeighInPanel products={products} currentUser={currentUser} onChanged={refresh} />}
        {tab === "users" && currentUser.role === "admin" && <UsersPanel />}
        {tab === "settings" && currentUser.role === "admin" && (
          <SettingsPanel autoPrint={autoPrint} onAutoPrintChange={setAutoPrint} printStyle={printStyle} onPrintStyleChange={setPrintStyle} printerMap={printerMap} onPrinterMapChange={setPrinterMap} branding={branding} onBrandingChange={onBrandingChange} />
        )}
        {tab === "reports" && currentUser.role === "admin" && <ReportsPanel />}
      </main>
    </div>
  );
}

// ── Order entry ───────────────────────────────────────────────────────────────

// "New order" form: customer details, pickup/delivery, one or more line
// items. On submit, optionally auto-prints kitchen/counter/master receipts
// per-department based on which departments actually have items.
function OrderEntry({ products, currentUser, autoPrint, printStyle, printerMap, onCreated }: { products: Product[]; currentUser: User; autoPrint: boolean; printStyle: string; printerMap: Record<string, string>; onCreated: (order: Order) => void }) {
  const defaultDept: Department = currentUser.department ?? "counter";
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [orderType, setOrderType] = useState<"pickup" | "delivery">("pickup");
  const [addr, setAddr] = useState<DeliveryAddress>({ street: "", area: "", buildingType: "", apartment: "" });
  const [requestedTime, setRequestedTime] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [items, setItems] = useState<OrderItemInput[]>([{ ...emptyLine, department: defaultDept }]);

  const canSave = customerName.trim() && customerPhone.trim() && items.some((i) => i.name.trim());

  const setLine = (index: number, patch: Partial<OrderItemInput>) =>
    setItems((cur) => cur.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const chooseProduct = (index: number, productId: string) => {
    const p = products.find((x) => x.id === Number(productId));
    if (!p) { setLine(index, { productId: null, name: "", unitPrice: null, notes: "", department: defaultDept }); return; }
    setLine(index, { productId: p.id, name: p.name, unitPrice: p.pricePerUnit, notes: p.prepNotes, department: p.department });
  };

  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);

  // A scanned/quick-created product only tells us item + price, not
  // kg/quantity — appended as a new line (replacing a still-blank first
  // line rather than piling up empties) for the cashier to fill in weight/qty.
  const addLineFromBarcode = (p: Product) => {
    const newLine: OrderItemInput = { productId: p.id, name: p.name, kg: null, quantity: null, notes: p.prepNotes, unitPrice: p.pricePerUnit, lineTotal: null, department: p.department };
    setItems((cur) => (cur.length === 1 && !cur[0].name.trim() ? [newLine] : [...cur, newLine]));
    setBarcodeModalOpen(false);
  };

  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || submitting) return;
    setSubmitError(""); setSubmitting(true);
    const payload: CreateOrderInput = {
      customerName,
      customerPhone,
      orderType,
      deliveryAddress: orderType === "delivery" ? addr : { street: "", area: "", buildingType: "", apartment: "" },
      requestedTime,
      assignedTo,
      items: items
        .filter((i) => i.name.trim())
        .map((i) => ({ ...i, kg: i.kg ? Number(i.kg) : null, quantity: i.quantity ? Number(i.quantity) : null, lineTotal: calculateLineTotal(i) }))
    };
    try {
      const order = await api.orders.create(payload);
      setCustomerName(""); setCustomerPhone(""); setOrderType("pickup");
      setAddr({ street: "", area: "", buildingType: "", apartment: "" }); setRequestedTime(""); setAssignedTo("");
      setItems([{ ...emptyLine, department: defaultDept }]);
      onCreated(order);
      if (autoPrint) {
        const hasK = order.items.some((i) => i.department === "kitchen");
        const hasC = order.items.some((i) => i.department === "counter");
        if (hasK) void printReceipt(order, "kitchen", printStyle, printerMap.kitchen ?? "");
        if (hasC) void printReceipt(order, "counter", printStyle, printerMap.counter ?? "");
        void printReceipt(order, "master", printStyle, printerMap.master ?? "");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel order-entry" onSubmit={(e) => void submit(e)}>
      <section className="form-grid">
        <label>Customer name<input value={customerName} onChange={(e) => setCustomerName(e.target.value)} required /></label>
        <label>Phone<input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required /></label>
      </section>
      <div className="order-type-toggle">
        <button type="button" className={orderType === "pickup" ? "active" : "secondary"} onClick={() => setOrderType("pickup")}>Pickup</button>
        <button type="button" className={orderType === "delivery" ? "active" : "secondary"} onClick={() => setOrderType("delivery")}>Delivery</button>
      </div>
      {orderType === "delivery" && (
        <div className="address-fields">
          <label>Street address
            <input value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} placeholder="12 Main Road" required />
          </label>
          <label>Area
            <input value={addr.area} onChange={(e) => setAddr({ ...addr, area: e.target.value })} placeholder="Sandton" required />
          </label>
          <div className="building-type-toggle">
            <span>Type</span>
            <button type="button" className={addr.buildingType === "house" ? "active" : "secondary"} onClick={() => setAddr({ ...addr, buildingType: "house", apartment: "" })}>House</button>
            <button type="button" className={addr.buildingType === "building" ? "active" : "secondary"} onClick={() => setAddr({ ...addr, buildingType: "building" })}>Building</button>
          </div>
          {addr.buildingType === "building" && (
            <label>Apartment / unit number
              <input value={addr.apartment} onChange={(e) => setAddr({ ...addr, apartment: e.target.value })} placeholder="Apt 4B" />
            </label>
          )}
        </div>
      )}
      <label className="optional-time">
        {orderType === "delivery" ? "Requested delivery time" : "Requested pickup time"} <span className="optional-hint">(optional)</span>
        <input type="datetime-local" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
      </label>
      <label className="optional-time">
        Assign to <span className="optional-hint">(optional)</span>
        <input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} placeholder="Staff member who should complete this order" />
      </label>

      <div className="line-list">
        {items.map((item, index) => (
          <div className="line-row" key={index}>
            <label>
              Product
              <ProductCombobox
                products={products}
                productId={String(item.productId ?? "")}
                itemName={item.name}
                onSelect={(id) => chooseProduct(index, id)}
                onNameChange={(name) => setLine(index, { name })}
              />
            </label>
            <label>
              Kg
              <input type="number" min="0" step="0.001" value={item.kg ?? ""} onChange={(e) => setLine(index, { kg: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label>
              Qty
              <input type="number" min="0" step="1" value={item.quantity ?? ""} onChange={(e) => setLine(index, { quantity: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label>
              Dept
              <select value={item.department} onChange={(e) => setLine(index, { department: e.target.value as Department })}>
                <option value="counter">Counter</option>
                <option value="kitchen">Kitchen</option>
              </select>
            </label>
            <label>
              Notes
              <input value={item.notes} onChange={(e) => setLine(index, { notes: e.target.value })} />
            </label>
            <button
              type="button" className="icon-button danger"
              onClick={() => setItems((cur) => cur.filter((_, i) => i !== index))}
              title="Remove line" aria-label="Remove line" disabled={items.length === 1}
            ><Trash2 size={18} /></button>
          </div>
        ))}
      </div>

      <footer className="actions">
        <button type="button" className="secondary" onClick={() => setItems((cur) => [...cur, { ...emptyLine, department: defaultDept }])}>
          <Plus size={18} /> Add item
        </button>
        <button type="button" className="secondary" onClick={() => setBarcodeModalOpen(true)}>
          <ScanLine size={18} /> Scan barcode
        </button>
        <button type="submit" disabled={!canSave || submitting}><Save size={18} /> {submitting ? "Creating…" : "Create Order"}</button>
      </footer>
      {submitError && <p className="form-error">{submitError}</p>}
      {barcodeModalOpen && (
        <BarcodeAddModal defaultDept={defaultDept} onAdd={addLineFromBarcode} onClose={() => setBarcodeModalOpen(false)} />
      )}
    </form>
  );
}

// ── Barcode add modal ────────────────────────────────────────────────────────
// Camera-based barcode scanning (via the browser's BarcodeDetector API, not
// a native Capacitor plugin) plus a manual-entry fallback for when the
// camera isn't available or the device doesn't support BarcodeDetector.
// Same code path works in both a desktop/mobile browser and the Android
// app's WebView, since it's a standard web API rather than native code.
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

type BarcodeStep = "choice" | "scan" | "manual" | "create";

function BarcodeAddModal({ defaultDept, onAdd, onClose }: { defaultDept: Department; onAdd: (p: Product) => void; onClose: () => void }) {
  const [step, setStep] = useState<BarcodeStep>("choice");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [pendingBarcode, setPendingBarcode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPrice, setCreatePrice] = useState("");
  const [createDept, setCreateDept] = useState<Department>(defaultDept);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cameraSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices && "BarcodeDetector" in window;

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Looks up a resolved barcode (from either scan or manual entry); on a
  // 404 it's treated as "not found yet" and routes to quick-create rather
  // than a dead-end error, per how this feature is meant to work.
  const resolveBarcode = async (code: string) => {
    setBusy(true); setError("");
    try {
      const product = await api.products.getByBarcode(code);
      onAdd(product);
    } catch {
      setPendingBarcode(code);
      setCreateName(""); setCreatePrice(""); setCreateDept(defaultDept);
      setStep("create");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step !== "scan") return;
    if (!cameraSupported) { setError("Camera scanning isn't supported on this device — enter the barcode manually instead."); setStep("choice"); return; }

    let cancelled = false;
    let intervalId: number;
    const detector = new BarcodeDetector({ formats: BARCODE_FORMATS });

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play(); }
        intervalId = window.setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const results = await detector.detect(videoRef.current);
            if (results.length > 0) {
              window.clearInterval(intervalId);
              stopCamera();
              void resolveBarcode(results[0].rawValue);
            }
          } catch { /* transient decode failure — retried on the next tick */ }
        }, 300);
      })
      .catch(() => { if (!cancelled) { setError("Couldn't access the camera — check permissions, or enter the barcode manually."); setStep("choice"); } });

    return () => { cancelled = true; window.clearInterval(intervalId); stopCamera(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    void resolveBarcode(manualCode.trim());
  };

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) { setError("Enter a name."); return; }
    setBusy(true); setError("");
    try {
      const product = await api.products.quickCreate({
        name: createName.trim(),
        barcode: pendingBarcode,
        pricePerUnit: createPrice ? Number(createPrice) : null,
        department: createDept
      });
      onAdd(product);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create product.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>Add by barcode</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {step === "choice" && (
          <div className="modal-body barcode-choice">
            <button type="button" onClick={() => setStep("scan")}><ScanLine size={18} /> Scan with camera</button>
            <button type="button" className="secondary" onClick={() => { setManualCode(""); setStep("manual"); }}>Enter barcode manually</button>
          </div>
        )}

        {step === "scan" && (
          <div className="modal-body barcode-scan">
            <video ref={videoRef} className="barcode-video" muted playsInline />
            <p className="settings-hint">Point the camera at the barcode.</p>
            <button type="button" className="secondary" onClick={() => setStep("choice")}>Cancel</button>
          </div>
        )}

        {step === "manual" && (
          <form className="modal-body" onSubmit={submitManual}>
            <label>Barcode
              <input inputMode="numeric" autoFocus value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="e.g. 6001234567890" />
            </label>
            <footer className="actions">
              <button type="button" className="secondary" onClick={() => setStep("choice")}>Back</button>
              <button type="submit" disabled={busy || !manualCode.trim()}>{busy ? "Looking up…" : "Find item"}</button>
            </footer>
          </form>
        )}

        {step === "create" && (
          <form className="modal-body" onSubmit={(e) => void submitCreate(e)}>
            <p className="settings-hint">No item found for barcode <b>{pendingBarcode}</b> — add it now.</p>
            <label>Name<input value={createName} onChange={(e) => setCreateName(e.target.value)} autoFocus required /></label>
            <label>R/kg<input type="number" min="0" step="0.01" value={createPrice} onChange={(e) => setCreatePrice(e.target.value)} /></label>
            <label>
              Department
              <select value={createDept} onChange={(e) => setCreateDept(e.target.value as Department)}>
                <option value="counter">Counter (raw meat)</option>
                <option value="kitchen">Kitchen (cooked)</option>
              </select>
            </label>
            <footer className="actions">
              <button type="button" className="secondary" onClick={() => setStep("choice")}>Back</button>
              <button type="submit" disabled={busy || !createName.trim()}>{busy ? "Adding…" : "Add item"}</button>
            </footer>
          </form>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

// ── Product combobox ──────────────────────────────────────────────────────────

// Autocomplete input for picking a catalog product on an order line, while
// still allowing arbitrary free text for one-off items not in the catalog
// (isFreeText tracks whether the line currently has no productId attached).
function ProductCombobox({ products, productId, itemName, onSelect, onNameChange }: {
  products: Product[];
  productId: string;
  itemName: string;
  onSelect: (id: string) => void;
  onNameChange: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const isFreeText = !productId;
  const selected = products.find((p) => String(p.id) === productId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return products;
    const q = query.toLowerCase();
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }, [products, query]);

  const pick = (id: string) => { onSelect(id); setQuery(""); setOpen(false); };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setOpen(true);
    if (isFreeText) onNameChange(val);
  };

  const handleFocus = () => {
    if (isFreeText) setQuery(itemName);
    setOpen(true);
  };

  const displayValue = open ? query : (selected?.name ?? itemName);

  return (
    <div className="combo-wrap" ref={wrapRef}>
      <input
        value={displayValue}
        placeholder={isFreeText ? "Type item name or search products…" : "Search products…"}
        autoComplete="off"
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
      />
      {open && (
        <div className="combo-dropdown">
          {productId && <div className="combo-option combo-free" onMouseDown={() => pick("")}>— Clear / free text —</div>}
          {filtered.map((p) => (
            <div key={p.id} className={`combo-option${String(p.id) === productId ? " combo-selected" : ""}`} onMouseDown={() => pick(String(p.id))}>
              <span>{p.name}</span>
              <small>{p.category} · {p.department}</small>
            </div>
          ))}
          {filtered.length === 0 && query && <div className="combo-empty">No matches — press Escape to stay as free text</div>}
        </div>
      )}
    </div>
  );
}

// ── Queue ─────────────────────────────────────────────────────────────────────

// Live queue of active tickets, sorted by urgency. A search filter re-sorts
// (rather than hides) so matching tickets float to the top without losing
// sight of the rest of the queue.
function Queue({ orders, currentUser, onChanged, printStyle, printerMap }: { orders: Order[]; currentUser: User; onChanged: () => Promise<void>; printStyle: string; printerMap: Record<string, string> }) {
  const [search, setSearch] = useState("");
  const sorted = useMemo(() => sortByUrgency(orders), [orders]);
  const displayed = useMemo(() => {
    if (!search.trim()) return sorted;
    const q = search.toLowerCase();
    const hits = (o: Order) =>
      o.customerName.toLowerCase().includes(q) ||
      o.customerPhone.includes(q) ||
      o.ticketNumber.toLowerCase().includes(q) ||
      o.items.some((i) => i.name.toLowerCase().includes(q));
    return [...sorted.filter(hits), ...sorted.filter((o) => !hits(o))];
  }, [sorted, search]);

  return (
    <>
      <div className="search-bar">
        <input placeholder="Search by name, phone, ticket or item…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
      </div>
      {displayed.length === 0
        ? <EmptyState title="No active tickets" detail="New orders will appear here." />
        : <div className="ticket-grid">{displayed.map((order) => <TicketCard key={order.id} order={order} currentUser={currentUser} onChanged={onChanged} printStyle={printStyle} printerMap={printerMap} />)}</div>
      }
    </>
  );
}

// ── Ticket card ───────────────────────────────────────────────────────────────

// One order's card in the Queue. Kitchen/counter roles only see and act on
// their own department's items/status; admin/master_cashier see and can
// advance both independently, or use Accept All/Complete All as a shortcut.
function TicketCard({ order, currentUser, onChanged, printStyle, printerMap }: { order: Order; currentUser: User; onChanged: () => Promise<void>; printStyle: string; printerMap: Record<string, string> }) {
  // Kitchen/counter staff only ever see their own department's line items.
  const visibleItems =
    currentUser.role === "kitchen" ? order.items.filter((i) => i.department === "kitchen") :
    currentUser.role === "counter" ? order.items.filter((i) => i.department === "counter") :
    order.items;

  const hasKitchen = order.kitchenStatus !== "n/a";
  const hasCounter = order.counterStatus !== "n/a";
  const isMasterCashier = currentUser.role === "master_cashier";

  const advanceDept = async (dept: Department, current: DeptStatus) => {
    const next = nextDeptStatus(current);
    if (!next) return;
    await api.orders.updateDeptStatus(order.id, dept, next);
    await onChanged();
  };

  const acceptAll = async () => {
    if (hasKitchen && order.kitchenStatus === "New") await api.orders.updateDeptStatus(order.id, "kitchen", "Received");
    if (hasCounter && order.counterStatus === "New") await api.orders.updateDeptStatus(order.id, "counter", "Received");
    await onChanged();
  };

  const completeAll = async () => {
    if (hasKitchen && order.kitchenStatus !== "Done" && order.kitchenStatus !== "n/a") await api.orders.updateDeptStatus(order.id, "kitchen", "Done");
    if (hasCounter && order.counterStatus !== "Done" && order.counterStatus !== "n/a") await api.orders.updateDeptStatus(order.id, "counter", "Done");
    await onChanged();
  };

  const canActKitchen = currentUser.role === "admin" || currentUser.role === "kitchen";
  const canActCounter = currentUser.role === "admin" || currentUser.role === "counter";

  return (
    <article className={`ticket status-${order.status.toLowerCase()}`}>
      <header>
        <div>
          <strong>{order.ticketNumber}</strong>
          <span>{new Date(order.createdAt).toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div className="header-badges">
          {order.requestedTime && (() => {
            const { label, color } = urgencyInfo(order.requestedTime);
            return <span className="urgency-badge" style={{ background: color }}>{label}</span>;
          })()}
          <span className="badge">{order.status}</span>
        </div>
      </header>

      <div className="tc-customer">
        <div className="tc-name-row">
          <b>{order.customerName}</b>
          <span className={`order-type-badge ${order.orderType}`}>{order.orderType === "delivery" ? "Delivery" : "Pickup"}</span>
        </div>
        <span className="tc-phone">{order.customerPhone}</span>
        {order.orderType === "delivery" && order.deliveryAddress?.street && (
          <span className="delivery-address">
            {order.deliveryAddress.street}, {order.deliveryAddress.area}
            {order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment
              ? ` — Apt ${order.deliveryAddress.apartment}` : ""}
          </span>
        )}
        {order.requestedTime && (
          <span className="requested-time">{order.orderType === "delivery" ? "Deliver at" : "Pickup at"} {formatRequestedTime(order.requestedTime)}</span>
        )}
      </div>

      {(order.requestedByName || order.assignedTo) && (
        <div className="tc-meta">
          {order.requestedByName && <span>Served by <b>{order.requestedByName}</b></span>}
          {order.requestedByName && order.assignedTo && <span className="tc-dot">·</span>}
          {order.assignedTo && <span>Assigned: <b>{order.assignedTo}</b></span>}
        </div>
      )}

      {(hasKitchen || hasCounter) && (
        <div className="dept-statuses">
          {hasKitchen && <span className={`dept-badge kitchen ds-${order.kitchenStatus.toLowerCase()}`}>Kitchen: {order.kitchenStatus}</span>}
          {hasCounter && <span className={`dept-badge counter ds-${order.counterStatus.toLowerCase()}`}>Counter: {order.counterStatus}</span>}
        </div>
      )}

      <ul>
        {visibleItems.map((item) => (
          <li key={item.id}>
            <div>
              <b>{item.name}</b>
              {currentUser.role === "admin" && <span className={`item-dept ${item.department}`}>{item.department}</span>}
              {item.notes && <span>{item.notes}</span>}
            </div>
            <em>
              {item.kg ? `${item.kg} kg` : ""}
              {item.quantity ? ` ×${item.quantity}` : ""}
            </em>
          </li>
        ))}
      </ul>

      <footer>
        <div className="ticket-actions">
          {hasKitchen && <button className="secondary sm" onClick={() => void printReceipt(order, "kitchen", printStyle, printerMap.kitchen ?? "")} title="Print kitchen receipt">Kitchen</button>}
          {hasCounter && <button className="secondary sm" onClick={() => void printReceipt(order, "counter", printStyle, printerMap.counter ?? "")} title="Print counter receipt">Counter</button>}
          <button className="secondary sm" onClick={() => void printReceipt(order, "master", printStyle, printerMap.master ?? "")} title="Print master receipt"><Printer size={16} /> Receipt</button>
          {isMasterCashier && order.status !== "Done" && (
            <>
              {(order.kitchenStatus === "New" || order.counterStatus === "New") && (
                <button onClick={() => void acceptAll()}>Accept</button>
              )}
              <button onClick={() => void completeAll()}>Complete</button>
            </>
          )}
          {!isMasterCashier && hasKitchen && canActKitchen && nextDeptStatus(order.kitchenStatus) && (
            <button onClick={() => void advanceDept("kitchen", order.kitchenStatus)}>
              Kitchen → {nextDeptStatus(order.kitchenStatus)}
            </button>
          )}
          {!isMasterCashier && hasCounter && canActCounter && nextDeptStatus(order.counterStatus) && (
            <button onClick={() => void advanceDept("counter", order.counterStatus)}>
              Counter → {nextDeptStatus(order.counterStatus)}
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}

// ── History ───────────────────────────────────────────────────────────────────

// Table of completed ("Done") orders within the configured retention window.
function HistoryView({ orders, printStyle, printerMap }: { orders: Order[]; printStyle: string; printerMap: Record<string, string> }) {
  const [search, setSearch] = useState("");
  const displayed = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    const hits = (o: Order) =>
      o.customerName.toLowerCase().includes(q) ||
      o.customerPhone.includes(q) ||
      o.ticketNumber.toLowerCase().includes(q) ||
      (o.requestedByName ?? "").toLowerCase().includes(q) ||
      o.items.some((i) => i.name.toLowerCase().includes(q));
    return [...orders.filter(hits), ...orders.filter((o) => !hits(o))];
  }, [orders, search]);

  if (orders.length === 0) return <EmptyState title="No completed orders yet" detail="Done tickets are kept here." />;
  return (
    <div className="panel table-panel">
      <div className="search-bar">
        <input placeholder="Search by name, phone, ticket, item or staff…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
      </div>
      <table>
          <thead>
            <tr><th>Ticket</th><th>Customer</th><th>Phone</th><th>Requested by</th><th>Items</th><th>Completed</th><th></th></tr>
          </thead>
          <tbody>
            {displayed.map((order) => (
              <tr key={order.id}>
                <td>{order.ticketNumber}</td>
                <td>{order.customerName}</td>
                <td>{order.customerPhone}</td>
                <td>{order.requestedByName ?? "—"}</td>
                <td>{order.items.length}</td>
                <td>{new Date(order.updatedAt).toLocaleString(appSettings.locale)}</td>
                <td>
                  <button className="secondary sm" onClick={() => void printReceipt(order, "master", printStyle, printerMap.master ?? "")} title="Print master receipt"><Printer size={16} /> Print</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
    </div>
  );
}

// ── Products ──────────────────────────────────────────────────────────────────

// Admin product catalog editor: add/edit/delete products, set price and
// low-stock threshold. CSV import/export lives in SettingsPanel, not here.
function Products({ products, onChanged }: { products: Product[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<ProductInput>(EMPTY_PRODUCT);
  const [stockMessage, setStockMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = editing.name.trim();
    if (!name) { setStockMessage("Enter a name."); return; }
    setBusy(true); setStockMessage("");
    try {
      await api.products.save({ ...editing, name, unitDefault: "kg", category: editing.category.trim() || "General", prepNotes: editing.prepNotes.trim() });
      setEditing(EMPTY_PRODUCT);
      setStockMessage("Saved.");
    } catch (err) {
      setStockMessage(err instanceof Error ? err.message : "Could not save.");
      return;
    } finally { setBusy(false); }
    await onChanged().catch(() => undefined);
  };

  const remove = async (id: number, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await api.products.delete(id);
    await onChanged();
  };

  return (
    <div className="products-layout">
      <form className="panel product-form" onSubmit={(e) => void save(e)}>
        <h2>{editing.id ? "Edit item" : "Add item"}</h2>
        <label>Name<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></label>
        <label>
          Category
          <input value={editing.category} list="categories" onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="General" />
          <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label>
          Department
          <select value={editing.department} onChange={(e) => setEditing({ ...editing, department: e.target.value as Department })}>
            <option value="counter">Counter (raw meat)</option>
            <option value="kitchen">Kitchen (cooked)</option>
          </select>
        </label>
        <label>
          R/kg
          <input type="number" min="0" step="0.01" value={editing.pricePerUnit ?? ""} onChange={(e) => setEditing({ ...editing, pricePerUnit: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label>Prep notes<textarea value={editing.prepNotes} onChange={(e) => setEditing({ ...editing, prepNotes: e.target.value })} /></label>
        <label>
          Barcode <span className="optional-hint">(optional — auto-filled by the Scan barcode button on new orders)</span>
          <input value={editing.barcode ?? ""} onChange={(e) => setEditing({ ...editing, barcode: e.target.value })} placeholder="e.g. 6001234567890" />
        </label>
        <label>
          Low-stock threshold
          <input type="number" min="0" step="0.01" placeholder="No warning" value={editing.lowStockThreshold ?? ""} onChange={(e) => setEditing({ ...editing, lowStockThreshold: e.target.value ? Number(e.target.value) : null })} />
        </label>
        {stockMessage && <div className="form-message">{stockMessage}</div>}
        <footer className="actions">
          {editing.id && <button type="button" className="secondary" onClick={() => { setEditing(EMPTY_PRODUCT); setStockMessage(""); }}>Cancel</button>}
          <button type="submit" disabled={busy}><Save size={18} /> {busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>

      {products.length === 0 ? (
        <EmptyState title="No items yet" detail="Add your first item using the form on the left." />
      ) : (
        <div className="panel table-panel">
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Dept</th><th>R/kg</th><th>On hand</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {products.map((p) => {
                const low = p.lowStockThreshold != null && p.onHandQty <= p.lowStockThreshold;
                return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td><span className={`dept-badge ${p.department}`}>{p.department}</span></td>
                  <td>{p.pricePerUnit ? currency.format(p.pricePerUnit) : ""}</td>
                  <td>{p.onHandQty}{low && <span className="low-stock-badge">Low</span>}</td>
                  <td>{p.prepNotes}</td>
                  <td className="row-actions">
                    <button type="button" className="secondary" onClick={() => setEditing(p)}>Edit</button>
                    <button type="button" className="icon-button danger" onClick={() => void remove(p.id, p.name)} title="Delete"><Trash2 size={18} /></button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Stock take ────────────────────────────────────────────────────────────────

// Physical stock recount screen: one input per product to overwrite
// onHandQty directly (as opposed to the incremental weigh-in deltas).
function StockTakePanel({ products, onChanged }: { products: Product[]; onChanged: () => Promise<void> }) {
  const [msg, setMsg] = useState("");

  const submit = async (productId: number, value: string) => {
    const qty = Number(value);
    if (Number.isNaN(qty) || qty < 0) return;
    try {
      await api.stock.update(productId, qty);
      setMsg("Stock count saved.");
      await onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save count.");
    } finally {
      window.setTimeout(() => setMsg(""), 2500);
    }
  };

  if (products.length === 0) {
    return <EmptyState title="No items yet" detail="An admin needs to add items in Stock before they can be counted here." />;
  }

  return (
    <div className="panel table-panel">
      <p className="settings-hint">Enter the current on-hand quantity for each item. This replaces the previous count.</p>
      {msg && <div className="form-message">{msg}</div>}
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>On hand</th><th>Threshold</th><th>Last counted</th></tr></thead>
        <tbody>
          {products.map((p) => {
            const low = p.lowStockThreshold != null && p.onHandQty <= p.lowStockThreshold;
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.category}</td>
                <td>
                  <input
                    type="number" min="0" step="0.01" defaultValue={p.onHandQty}
                    key={`${p.id}-${p.onHandQty}`}
                    onBlur={(e) => void submit(p.id, e.target.value)}
                  />
                  {low && <span className="low-stock-badge">Low</span>}
                </td>
                <td>{p.lowStockThreshold ?? "—"}</td>
                <td className="settings-hint">{p.lastCountedAt ? new Date(p.lastCountedAt).toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" }) : "Never"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Weigh-in (batch) ──────────────────────────────────────────────────────────
// Stock-in workflow: the stock taker logs incoming deliveries one line at a
// time into an open batch, then finalizes it to lock the batch and print a
// summary. See buildWeighInSummaryHtml below for how the printout is built.

const GRADE_LETTERS: ("A" | "B" | "C")[] = ["A", "B", "C"];
// Per-item defaults for "pieces received", matched by exact lowercased name;
// anything not listed falls back to 2 (defaultPiecesFor's `|| 2`).
const ITEM_PIECE_DEFAULTS: Record<string, number> = { "beef forequarter": 2, "whole lamb": 8 };
const defaultPiecesFor = (name: string | undefined) => (name && ITEM_PIECE_DEFAULTS[name.trim().toLowerCase()]) || 2;

// Log-received-stock form + current in-progress batch table + (admin-only)
// finalized-batch history with a printable summary per batch.
function WeighInPanel({ products, currentUser, onChanged }: { products: Product[]; currentUser: User; onChanged: () => Promise<void> }) {
  const [lines, setLines] = useState<WeighInLine[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [productId, setProductId] = useState<number | "">("");
  const [grades, setGrades] = useState<Record<"A" | "B" | "C", boolean>>({ A: false, B: false, C: false });
  const [pieces, setPieces] = useState(2);
  const [weightKg, setWeightKg] = useState("");
  const [supplierId, setSupplierId] = useState<number | "" | "new">("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [msg, setMsg] = useState("");
  const [history, setHistory] = useState<WeighInBatchSummary[]>([]);
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editingLineId, setEditingLineId] = useState<number | null>(null);

  const loadCurrent = () => api.weighIn.current().then((r) => setLines(r.lines)).catch(() => undefined);
  const loadSuppliers = () => api.suppliers.list().then(setSuppliers).catch(() => undefined);
  // Takes explicit from/to (defaulting to current state) rather than reading
  // historyFrom/historyTo directly, so the Clear button can pass "" for both
  // and refetch immediately without waiting on React's async state update
  // (calling loadHistory() right after setHistoryFrom("") would otherwise
  // still see the old value due to stale closures).
  const loadHistory = (from = historyFrom, to = historyTo) => {
    if (currentUser.role !== "admin") return;
    setHistoryLoading(true);
    api.weighIn.list(from && to ? from : undefined, from && to ? to : undefined)
      .then(setHistory).catch(() => undefined).finally(() => setHistoryLoading(false));
  };

  useEffect(() => { void loadCurrent(); void loadSuppliers(); loadHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const printBatch = async (batchId: number) => {
    try {
      const { batch, lines: batchLines } = await api.weighIn.get(batchId);
      printHtml(buildWeighInSummaryHtml(batch.finalizedAt ?? batch.createdAt, batchLines, products));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not load batch for printing.");
      window.setTimeout(() => setMsg(""), 3000);
    }
  };

  const totals = useMemo(
    () => lines.reduce((acc, l) => ({ pieces: acc.pieces + l.piecesReceived, weightKg: acc.weightKg + l.weightKg }), { pieces: 0, weightKg: 0 }),
    [lines]
  );

  // Beef Forequarter and Whole Lamb are the highest-volume items — always
  // pin them first (in that order) in the Item dropdown, ahead of the rest
  // in their normal catalog order, regardless of how many other items exist.
  const orderedItemOptions = useMemo(() => {
    const pinnedNames = Object.keys(ITEM_PIECE_DEFAULTS);
    const byLowerName = (n: string) => n.trim().toLowerCase();
    const pinned = pinnedNames
      .map((name) => products.find((p) => byLowerName(p.name) === name))
      .filter((p): p is Product => Boolean(p));
    const pinnedIds = new Set(pinned.map((p) => p.id));
    return [...pinned, ...products.filter((p) => !pinnedIds.has(p.id))];
  }, [products]);

  const toggleGrade = (g: "A" | "B" | "C") =>
    setGrades((cur) => {
      const next = { ...cur, [g]: !cur[g] };
      // Cap at 2 grades selected (A+B, A+C, B+C — not all three at once)
      if (Object.values(next).filter(Boolean).length > 2) return cur;
      return next;
    });

  // Loads an existing line's values into the form for editing. The delete
  // button in the footer only appears once a line is being edited (see the
  // "editingLineId &&" gate below), so deletion is always a deliberate
  // two-step action, not a stray click.
  const startEdit = (line: WeighInLine) => {
    setEditingLineId(line.id);
    setProductId(line.productId);
    const parts = line.grade.split(",");
    setGrades({ A: parts.includes("A"), B: parts.includes("B"), C: parts.includes("C") });
    setPieces(line.piecesReceived);
    setWeightKg(String(line.weightKg));
    setSupplierId(line.supplierId);
    setNewSupplierName("");
    setMsg("");
  };

  const cancelEdit = () => {
    setEditingLineId(null);
    setProductId(""); setGrades({ A: false, B: false, C: false }); setPieces(2); setWeightKg("");
    setMsg("");
  };

  const deleteLine = async () => {
    if (!editingLineId) return;
    if (!window.confirm("Delete this line? This cannot be undone and will reverse its stock adjustment.")) return;
    setBusy(true);
    try {
      await api.weighIn.deleteLine(editingLineId);
      setLines((cur) => cur.filter((l) => l.id !== editingLineId));
      cancelEdit();
      setMsg("Line deleted.");
      await onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not delete line.");
    } finally {
      setBusy(false);
      window.setTimeout(() => setMsg(""), 3000);
    }
  };

  // Adds a new line or (if editingLineId is set) updates an existing one.
  // Two or more checked grades are combined into one line with a comma-
  // joined grade ("A,B") rather than creating a separate line per grade.
  const submitLine = async (e: FormEvent) => {
    e.preventDefault();
    const selectedGrades = GRADE_LETTERS.filter((g) => grades[g]);
    const grade = selectedGrades.join(",") as Grade;
    const weight = parseFloat(weightKg);
    if (!productId) { setMsg("Pick a product."); return; }
    if (selectedGrades.length === 0) { setMsg("Pick at least one grade."); return; }
    if (!pieces || pieces <= 0) { setMsg("Enter how many pieces were received."); return; }
    if (!weight || weight <= 0) { setMsg("Enter the weight in kg."); return; }
    if (supplierId === "" || (supplierId === "new" && !newSupplierName.trim())) { setMsg("Pick or add a supplier."); return; }

    const wasEditing = editingLineId;
    setBusy(true); setMsg("");
    // 5s cooldown on the Add/Update button to prevent accidental double-submits.
    setCooldown(true);
    window.setTimeout(() => setCooldown(false), 5000);
    try {
      let finalSupplierId = supplierId;
      if (finalSupplierId === "new") {
        const created = await api.suppliers.create(newSupplierName);
        setSuppliers((cur) => [...cur, created].sort((a, b) => a.name.localeCompare(b.name)));
        finalSupplierId = created.id;
        setNewSupplierName("");
      }

      const input = { productId, grade, piecesReceived: pieces, weightKg: weight, supplierId: finalSupplierId as number };
      if (wasEditing) {
        const updated = await api.weighIn.updateLine(wasEditing, input);
        setLines((cur) => cur.map((l) => (l.id === updated.id ? updated : l)));
        setEditingLineId(null);
        setProductId(""); setGrades({ A: false, B: false, C: false }); setPieces(2); setWeightKg("");
        setMsg("Line updated.");
      } else {
        const line = await api.weighIn.addLine(input);
        setLines((cur) => [...cur, line]);
        // Item and grade stay selected as defaults for the next line — only weight/pieces reset
        setPieces(defaultPiecesFor(products.find((p) => p.id === productId)?.name)); setWeightKg("");
        setMsg("Logged.");
      }
      setSupplierId(finalSupplierId);
      await onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save — please retry.");
    } finally {
      setBusy(false);
      window.setTimeout(() => setMsg(""), 3000);
    }
  };

  // Opens the same summary layout as finalize's printout, but without
  // locking the batch — lets the stock taker sanity-check totals first.
  const previewBatch = () => {
    if (lines.length === 0) { setMsg("No lines to preview."); window.setTimeout(() => setMsg(""), 3000); return; }
    printHtml(buildWeighInSummaryHtml(new Date().toISOString(), lines, products, "WEIGH-IN SUMMARY — PREVIEW"));
  };

  // Locks the current batch (no further edits/deletes) and opens the
  // printable summary — the batch's one-shot "close out and print" action.
  const finalize = async () => {
    if (lines.length === 0) { setMsg("No lines to finalize."); return; }
    if (!window.confirm(`Finalize this batch of ${lines.length} line${lines.length === 1 ? "" : "s"}? Lines can no longer be edited once finalized.`)) return;
    setBusy(true);
    try {
      const { batch, lines: finalLines } = await api.weighIn.finalize();
      printHtml(buildWeighInSummaryHtml(batch.finalizedAt ?? batch.createdAt, finalLines, products));
      setLines([]);
      loadHistory();
      setMsg("Batch finalized — print/save dialog opened.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not finalize batch.");
    } finally {
      setBusy(false);
      window.setTimeout(() => setMsg(""), 3000);
    }
  };

  return (
    <div className="products-layout">
      <form className="panel product-form" onSubmit={(e) => void submitLine(e)}>
        <h2>{editingLineId ? "Edit line" : "Log received stock"}</h2>
        <label>
          Item
          <select value={productId} onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : "";
            setProductId(id);
            setPieces(defaultPiecesFor(products.find((p) => p.id === id)?.name));
          }}>
            <option value="">— Select item —</option>
            {orderedItemOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Grade
          <div className="grade-picker">
            {GRADE_LETTERS.map((g) => (
              <label key={g} className={`grade-pill ${grades[g] ? "checked" : ""}`}>
                <input type="checkbox" checked={grades[g]} onChange={() => toggleGrade(g)} /> {g}
              </label>
            ))}
          </div>
        </label>
        <label>
          Pieces received
          <div className="stepper-row">
            <button type="button" className="secondary sm" onClick={() => setPieces((p) => Math.max(1, p - 1))}>−</button>
            <input type="number" inputMode="numeric" min="1" step="1" value={pieces} onChange={(e) => setPieces(Math.max(1, Number(e.target.value)))} />
            <button type="button" className="secondary sm" onClick={() => setPieces((p) => p + 1)}>+</button>
          </div>
        </label>
        <label>
          Weight (kg)
          <input type="number" inputMode="decimal" min="0" step="0.01" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} placeholder="0.00" />
        </label>
        <label>
          Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value === "new" ? "new" : e.target.value ? Number(e.target.value) : "")}>
            <option value="">— Select supplier —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="new">— Add new —</option>
          </select>
        </label>
        {supplierId === "new" && (
          <label>New supplier name<input value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} placeholder="Supplier name" /></label>
        )}
        {msg && <div className="form-message">{msg}</div>}
        <footer className="actions">
          {editingLineId && <button type="button" className="secondary danger" onClick={() => void deleteLine()} disabled={busy}>Delete line</button>}
          {editingLineId && <button type="button" className="secondary" onClick={cancelEdit}>Cancel</button>}
          <button type="submit" disabled={busy || cooldown}>
            <Save size={18} /> {busy ? "Saving…" : cooldown ? "Wait…" : editingLineId ? "Update line" : "Add line"}
          </button>
        </footer>
      </form>

      <div className="panel table-panel">
        <h2>Current batch</h2>
        <table>
          <thead><tr><th>Date</th><th>Item</th><th>Grade</th><th>Pieces</th><th>Kg</th><th>Supplier</th><th></th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={l.id === editingLineId ? "editing-row" : ""}>
                <td>{new Date(l.createdAt).toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{l.productName}</td>
                <td>{l.grade}</td>
                <td>{l.piecesReceived}</td>
                <td>{l.weightKg}</td>
                <td>{l.supplierName}</td>
                <td className="row-actions">
                  <button type="button" className="secondary sm" onClick={() => startEdit(l)}>Edit</button>
                </td>
              </tr>
            ))}
            {lines.length > 0 && (
              <tr className="totals-row"><td colSpan={3}><b>Total</b></td><td><b>{totals.pieces}</b></td><td><b>{totals.weightKg.toFixed(2)}</b></td><td></td><td></td></tr>
            )}
          </tbody>
        </table>
        <footer className="actions">
          <button type="button" className="secondary" onClick={previewBatch} disabled={lines.length === 0}><FileDown size={18} /> Preview</button>
          <button type="button" onClick={() => void finalize()} disabled={busy || lines.length === 0}><FileDown size={18} /> Finalize batch &amp; print</button>
        </footer>
      </div>

      {currentUser.role === "admin" && (
        <div className="panel reports-panel span-full">
          <h2>Weigh-in history</h2>
          <div className="report-controls">
            <label>From<input type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} /></label>
            <label>To<input type="date" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} /></label>
            <button type="button" onClick={() => loadHistory()} disabled={historyLoading}>{historyLoading ? "Loading…" : "Filter"}</button>
            {(historyFrom || historyTo) && (
              <button type="button" className="secondary" onClick={() => { setHistoryFrom(""); setHistoryTo(""); loadHistory("", ""); }}>
                Clear
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <p className="report-empty">{historyLoading ? "Loading…" : "No finalized batches found."}</p>
          ) : (
            <>
              <div className="report-summary">
                <strong>{history.length}</strong> batch{history.length !== 1 ? "es" : ""}
              </div>
              <div className="table-panel">
                <table>
                  <thead><tr><th>Date</th><th>Items</th><th>Suppliers</th><th>Lines</th><th>Pieces</th><th>Kg</th><th>Finalized by</th><th></th></tr></thead>
                  <tbody>
                    {history.map((b) => (
                      <tr key={b.id}>
                        <td>{b.finalizedAt ? new Date(b.finalizedAt).toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                        <td>{b.productNames ?? "—"}</td>
                        <td>{b.supplierNames ?? "—"}</td>
                        <td>{b.lineCount}</td>
                        <td>{b.totalPieces}</td>
                        <td>{b.totalKg.toFixed(2)}</td>
                        <td>{b.createdByName ?? "—"}</td>
                        <td className="row-actions">
                          <button type="button" className="secondary sm" onClick={() => void printBatch(b.id)}><FileDown size={16} /> Print</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Users (admin) ─────────────────────────────────────────────────────────────

const EMPTY_USER: UserInput = { name: "", pin: "", role: "cashier", department: null };
// Kitchen/counter roles are tied to that department; every other role has no department.
const roleDept = (role: UserInput["role"]): Department | null =>
  role === "kitchen" ? "kitchen" : role === "counter" ? "counter" : null;

// Admin-only staff account management: create/edit users, set roles/PINs,
// activate/deactivate (soft — see database.ts's admin-lockout guard).
function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState<UserInput>(EMPTY_USER);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.users.list().then(setUsers).catch(() => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const payload = { ...form, department: roleDept(form.role) };
      if (editingId) {
        // PIN field starts blank on edit (see startEdit) — only include it
        // in the patch if the admin actually typed a new one.
        const patch: Partial<UserInput> = { name: payload.name, role: payload.role, department: payload.department };
        if (form.pin) patch.pin = form.pin;
        await api.users.update(editingId, patch);
      } else {
        await api.users.create(payload);
      }
      setForm(EMPTY_USER); setEditingId(null); setMsg("Saved.");
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to save.");
    } finally { setBusy(false); }
  };

  const toggleActive = async (user: User) => {
    // Only confirm the deactivate direction — reactivating is harmless and
    // shouldn't need a prompt. Sits right next to "Edit" in a compact row,
    // so a mis-tap here would otherwise lock someone out with no warning.
    if (user.isActive && !window.confirm(`Deactivate ${user.name}? They won't be able to log in until reactivated.`)) return;
    try {
      await api.users.update(user.id, { isActive: user.isActive ? 0 : 1 });
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not update user");
    }
  };

  const startEdit = (user: User) => {
    setEditingId(user.id);
    setForm({ name: user.name, pin: "", role: user.role, department: user.department ?? "counter" });
  };

  return (
    <div className="products-layout">
      <form className="panel product-form" onSubmit={(e) => void save(e)}>
        <h2>{editingId ? "Edit user" : "Add user"}</h2>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>
          PIN (4 digits)
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={form.pin}
            onChange={(e) => setForm({ ...form, pin: e.target.value })}
            placeholder={editingId ? "Leave blank to keep current" : ""}
            required={!editingId}
          />
        </label>
        <label>
          Role
          <select value={form.role} onChange={(e) => {
            const role = e.target.value as UserInput["role"];
            setForm({ ...form, role, department: roleDept(role) });
          }}>
            <option value="cashier">Cashier</option>
            <option value="master_cashier">Master Cashier</option>
            <option value="counter">Counter</option>
            <option value="kitchen">Kitchen</option>
            <option value="stock_taker">Stock Taker</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {msg && <div className="form-message">{msg}</div>}
        <footer className="actions">
          {editingId && <button type="button" className="secondary" onClick={() => { setEditingId(null); setForm(EMPTY_USER); setMsg(""); }}>Cancel</button>}
          <button type="submit" disabled={busy}><Save size={18} /> {busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>

      <div className="panel table-panel">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Account</th><th>Online</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => {
              const online = !!u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 2 * 60 * 1000;
              return (
              <tr key={u.id} className={u.isActive ? "" : "inactive-row"}>
                <td>{u.name}</td>
                <td className="role-text">{u.role.replace("_", " ")}</td>
                <td>{u.isActive ? "Active" : "Inactive"}</td>
                <td>
                  <span className={`online-dot ${online ? "online" : "offline"}`}
                    title={online ? "Online now" : u.lastSeenAt
                      ? `Last seen ${new Date(u.lastSeenAt).toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" })}`
                      : "Never logged in"} />
                  {online ? <span className="online-text">Online</span> : null}
                </td>
                <td className="row-actions">
                  <button type="button" className="secondary" onClick={() => startEdit(u)}>Edit</button>
                  <button type="button" className="secondary" onClick={() => void toggleActive(u)}>
                    {u.isActive ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Settings (admin) ──────────────────────────────────────────────────────────

// Admin control panel: printing config, branding (site name/logo/theme
// color — also pushed live into buildReceiptHtml via setReceiptBranding so
// printed receipts match immediately), product CSV import/export, and
// full-database backup/restore.
function SettingsPanel({ autoPrint, onAutoPrintChange, printStyle, onPrintStyleChange, printerMap, onPrinterMapChange, branding, onBrandingChange }: { autoPrint: boolean; onAutoPrintChange: (v: boolean) => void; printStyle: string; onPrintStyleChange: (v: string) => void; printerMap: Record<string, string>; onPrinterMapChange: (v: { kitchen: string; counter: string; master: string }) => void; branding: { siteName: string; logoUrl: string }; onBrandingChange: (b: { siteName: string; logoUrl: string }) => void }) {
  const [msg, setMsg] = useState("");
  const [availablePrinters, setAvailablePrinters] = useState<string[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [historyDays, setHistoryDays] = useState(30);
  const [siteName, setSiteName] = useState(branding.siteName);
  const [themeColor, setThemeColor] = useState("#1a47a0");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const fetchPrinters = async () => {
    setLoadingPrinters(true);
    try { setAvailablePrinters(await api.printers.list()); }
    catch { /* ignore */ }
    finally { setLoadingPrinters(false); }
  };

  useEffect(() => { void fetchPrinters(); }, []);

  useEffect(() => {
    api.settings.get().then((s) => {
      setHistoryDays(Number(s.historyDays ?? 30));
      setThemeColor(s.themeColor || "#1a47a0");
    }).catch(() => undefined);
  }, []);

  const saveHistoryDays = async (days: number) => {
    await api.settings.set({ historyDays: String(days) });
    setHistoryDays(days);
    setMsg("History retention saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const saveSiteName = async (name: string) => {
    const trimmed = name.trim() || "MAXIS";
    await api.settings.set({ siteName: trimmed });
    onBrandingChange({ ...branding, siteName: trimmed });
    applyBranding(trimmed, branding.logoUrl);
    setReceiptBranding({ siteName: trimmed });
    setMsg("Site name saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { logoUrl } = await api.settings.uploadLogo(dataUrl);
      onBrandingChange({ ...branding, logoUrl });
      applyBranding(branding.siteName, logoUrl);
      setReceiptBranding({ logoUrl });
      setMsg("Logo updated");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
      window.setTimeout(() => setMsg(""), 2500);
    }
  };

  // Applies the new theme color immediately (live UI + future receipts via
  // the branding cache) before the save request even resolves, so the
  // color-picker feels instant rather than waiting on a round-trip.
  const saveThemeColor = async (hex: string) => {
    setThemeColor(hex);
    applyTheme(hex);
    setReceiptBranding({ themeColor: hex });
    await api.settings.set({ themeColor: hex });
  };

  const toggle = async () => {
    const next = !autoPrint;
    await api.settings.set({ autoPrint: String(next) });
    onAutoPrintChange(next);
    setMsg(next ? "Auto-print enabled" : "Auto-print disabled");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const changePrintStyle = async (style: string) => {
    await api.settings.set({ printStyle: style });
    onPrintStyleChange(style);
    setMsg("Receipt format updated");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const changePrinter = async (key: string, value: string) => {
    await api.settings.set({ [key]: value });
    onPrinterMapChange({ ...printerMap, [key.replace("Printer", "")]: value } as { kitchen: string; counter: string; master: string });
    setMsg("Printer assignment saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const csv = await file.text();
      const result = await api.products.import(csv);
      const errNote = result.errors.length ? ` (${result.errors.length} skipped)` : "";
      setMsg(`Imported ${result.imported} products${errNote}`);
    } catch (err) {
      setMsg(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
      window.setTimeout(() => setMsg(""), 4000);
    }
  };

  // Destructive — wipes and replaces the entire database from a backup
  // file (see database.ts's importBackup), so this is confirmed explicitly
  // rather than firing on file selection alone.
  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm("This will replace all products, users, orders and settings with the backup data. Continue?")) {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      return;
    }
    setRestoring(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as object;
      const result = await api.backup.restore(data);
      setMsg(`Restored: ${result.products} products, ${result.users} users, ${result.orders} orders`);
      window.setTimeout(() => setMsg(""), 5000);
    } catch (err) {
      setMsg(`Restore failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      window.setTimeout(() => setMsg(""), 5000);
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  return (
    <div className="panel settings-panel">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Printing</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Auto-print</strong>
            <p>When an order is created, automatically send the kitchen slip to the kitchen printer, the counter slip to the counter printer, and the master receipt to the cashier printer.</p>
          </div>
          <button type="button" className={autoPrint ? "toggle-on" : "toggle-off"} onClick={() => void toggle()}>
            {autoPrint ? "On" : "Off"}
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Receipt format</strong>
            <p>80mm thermal for counter use; A4 for full-page printing. Mix modes available.</p>
          </div>
          <select className="settings-select" value={printStyle} onChange={(e) => void changePrintStyle(e.target.value)}>
            <option value="thermal">All — thermal (80mm)</option>
            <option value="a4">All — A4</option>
            <option value="master_a4">Master A4 · dept thermal</option>
            <option value="dept_a4">Master thermal · dept A4</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <span>Printer assignments</span>
          <button type="button" className="secondary sm" onClick={() => void fetchPrinters()} disabled={loadingPrinters}>
            {loadingPrinters ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div className="printer-body">
          <p className="settings-hint">
            Pick a printer from the dropdown or type the CUPS printer name. Leave blank to use the browser print dialog.
            Hit <b>Test</b> to send a test page and confirm it works.
          </p>
          <datalist id="printer-list">
            {availablePrinters.map((p) => <option key={p} value={p} />)}
          </datalist>
          <div className="printer-assignments">
            {([ ["Kitchen printer", "kitchenPrinter", "kitchen"], ["Counter printer", "counterPrinter", "counter"], ["Master / cashier printer", "masterPrinter", "master"] ] as [string, string, string][]).map(([label, key, mapKey]) => (
              <div className="printer-row" key={key}>
                <span className="printer-row-label">{label}</span>
                <div className="printer-row-inputs">
                  <input
                    type="text"
                    list="printer-list"
                    placeholder="— Browser dialog —"
                    value={printerMap[mapKey] ?? ""}
                    onChange={(e) => void changePrinter(key, e.target.value)}
                    onBlur={(e) => void changePrinter(key, e.target.value)}
                  />
                  <button type="button" className="secondary sm" onClick={() => void printTestPage(printerMap[mapKey] ?? "")}>
                    Test
                  </button>
                </div>
              </div>
            ))}
          </div>
          {availablePrinters.length === 0 && !loadingPrinters && (
            <div className="printer-help">
              <p>No printers found automatically. If your printer is connected to the server, add it to CUPS first:</p>
              <div className="printer-help-cmds">
                <div><code>lpstat -a</code> — list printers already in CUPS</div>
                <div><code>lpadmin -p KitchenPrinter -v socket://192.168.x.x:9100 -E</code> — add a network printer</div>
                <div><code>lpadmin -p UsbPrinter -v usb://... -E</code> — add a USB printer</div>
              </div>
              <p>Once added to CUPS, click <b>Refresh</b> and the printer will appear in the dropdown.</p>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>Products</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Product catalog</strong>
            <p>Import a CSV to bulk-add or update products. Export downloads the full product list as a CSV.</p>
          </div>
          <div className="setting-actions">
            <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => void handleImport(e)} />
            <button type="button" className="secondary" disabled={importing} onClick={() => csvInputRef.current?.click()}>
              {importing ? "Importing…" : "Import CSV"}
            </button>
            <button type="button" className="secondary" onClick={() => void api.products.export()}>
              Export CSV
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Backup &amp; restore</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Full system backup</strong>
            <p>Download backs up everything — products, users, all orders and settings — as a JSON file. Restore loads a backup file and replaces the current data.</p>
          </div>
          <div className="setting-actions">
            <button type="button" className="secondary" onClick={() => void api.backup.download()}>
              Download backup
            </button>
            <input ref={restoreInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => void handleRestore(e)} />
            <button type="button" className="secondary danger" disabled={restoring} onClick={() => restoreInputRef.current?.click()}>
              {restoring ? "Restoring…" : "Restore backup"}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Branding</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Site name</strong>
            <p>Shown in the sidebar, login screen, and browser tab title.</p>
          </div>
          <input
            type="text" value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            onBlur={(e) => void saveSiteName(e.target.value)}
          />
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Logo</strong>
            <p>Replaces the logo on the login screen, sidebar, and browser tab icon.</p>
          </div>
          <div className="setting-actions">
            <img src={branding.logoUrl || "/logo.jpg"} alt="Current logo" className="login-logo" style={{ width: 40, height: 40 }} />
            <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => void handleLogoUpload(e)} />
            <button type="button" className="secondary" disabled={uploadingLogo} onClick={() => logoInputRef.current?.click()}>
              {uploadingLogo ? "Uploading…" : "Upload logo"}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Theme</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Brand color</strong>
            <p>Sets the primary color used across buttons, the sidebar, and highlights.</p>
          </div>
          <input type="color" value={themeColor} onChange={(e) => void saveThemeColor(e.target.value)} />
        </div>
      </section>

      <section className="settings-section">
        <h3>Order History</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>History retention</strong>
            <p>Completed orders older than this many days are hidden from the History tab. They are still visible in Reports.</p>
          </div>
          <div className="history-days-input">
            <input
              type="number"
              min="1"
              max="365"
              value={historyDays}
              onChange={(e) => setHistoryDays(Number(e.target.value))}
              onBlur={(e) => void saveHistoryDays(Math.max(1, Number(e.target.value)))}
            />
            <span>days</span>
          </div>
        </div>
      </section>

      {msg && <div className="form-message">{msg}</div>}
    </div>
  );
}

// ── Reports (admin) ───────────────────────────────────────────────────────────

// Admin sales reporting: date-range order lookup with a per-line-item CSV
// export (one row per order item, order fields repeated on each row).
function ReportsPanel() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadOrders = async () => {
    if (from > to) { setError("'From' must be on or before 'To'"); return; }
    setLoading(true); setError(""); setOrders(null);
    try {
      setOrders(await api.orders.export(from, to));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    } finally { setLoading(false); }
  };

  const downloadCsv = () => {
    if (!orders) return;
    const header = ["Ticket", "Date Created", "Customer", "Phone", "Type", "Delivery Address", "Requested Time", "Status", "Kitchen Status", "Counter Status", "Created By", "Completed At", "Item", "Dept", "Kg", "Qty", "Unit Price (R/kg)", "Line Total (R)"];
    const rows: string[][] = [header];

    for (const o of orders) {
      const dateFmt = new Date(o.createdAt).toLocaleString(appSettings.locale);
      const completedFmt = o.status === "Done" ? new Date(o.updatedAt).toLocaleString(appSettings.locale) : "";
      const addr = o.orderType === "delivery" && o.deliveryAddress?.street
        ? [o.deliveryAddress.street, o.deliveryAddress.area, o.deliveryAddress.apartment ? `Apt ${o.deliveryAddress.apartment}` : ""].filter(Boolean).join(", ")
        : "";
      const orderCols = [o.ticketNumber, dateFmt, o.customerName, o.customerPhone, o.orderType, addr, o.requestedTime, o.status, o.kitchenStatus, o.counterStatus, o.requestedByName ?? "", completedFmt];

      if (o.items.length === 0) {
        rows.push([...orderCols, "", "", "", "", "", ""]);
      } else {
        for (const item of o.items) {
          rows.push([
            ...orderCols,
            item.name, item.department,
            item.kg != null ? String(item.kg) : "",
            item.quantity != null ? String(item.quantity) : "",
            item.unitPrice != null ? item.unitPrice.toFixed(2) : "",
            item.lineTotal != null ? item.lineTotal.toFixed(2) : ""
          ]);
        }
      }
    }

    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    // UTF-8 BOM prefix so Excel opens the file with correct encoding instead
    // of misreading special characters (e.g. currency symbols) as Latin-1.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maxis-orders-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalValue = orders?.reduce((sum, o) => sum + o.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0), 0) ?? 0;

  return (
    <div className="panel reports-panel">
      <h2>Order Reports</h2>
      <div className="report-controls">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" onClick={() => void loadOrders()} disabled={loading}>
          {loading ? "Loading…" : "View"}
        </button>
        {orders && orders.length > 0 && (
          <button type="button" className="secondary" onClick={downloadCsv}>
            <FileDown size={16} /> Download CSV
          </button>
        )}
      </div>
      {error && <div className="form-message">{error}</div>}

      {orders !== null && (
        orders.length === 0
          ? <p className="report-empty">No orders found between {from} and {to}.</p>
          : <>
            <div className="report-summary">
              <strong>{orders.length}</strong> order{orders.length !== 1 ? "s" : ""}
              {totalValue > 0 && <> &nbsp;·&nbsp; Total value: <strong>{currency.format(totalValue)}</strong></>}
            </div>
            <div className="table-panel">
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Phone</th>
                    <th>Type</th>
                    <th>Requested Time</th>
                    <th>Status</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th>Created by</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const orderTotal = o.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
                    return (
                      <tr key={o.id}>
                        <td><strong>{o.ticketNumber}</strong></td>
                        <td>{new Date(o.createdAt).toLocaleString(appSettings.locale)}</td>
                        <td>{o.customerName}</td>
                        <td>{o.customerPhone}</td>
                        <td><span className={`order-type-badge ${o.orderType}`}>{o.orderType === "delivery" ? "Delivery" : "Pickup"}</span></td>
                        <td>{o.requestedTime ? formatRequestedTime(o.requestedTime) : "—"}</td>
                        <td><span className="badge">{o.status}</span></td>
                        <td>
                          {o.items.map((item, idx) => {
                            const qty = [item.kg ? `${item.kg}kg` : "", item.quantity ? `×${item.quantity}` : ""].filter(Boolean).join(" ");
                            return <div key={idx}>{item.name}{qty ? ` · ${qty}` : ""}</div>;
                          })}
                        </td>
                        <td>{orderTotal > 0 ? currency.format(orderTotal) : "—"}</td>
                        <td>{o.requestedByName ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
      )}
    </div>
  );
}

// ── Print ─────────────────────────────────────────────────────────────────────
// These are plain functions (not React components) because they build a
// complete standalone HTML document string — CSS inlined in a <style> tag,
// no dependency on this app's own stylesheet — which printHtml() then opens
// in its own tab/iframe for the browser's native print-to-PDF/printer flow.
// Reads branding from the module-level `receiptBranding` cache (set by
// App's boot effect and SettingsPanel) rather than a prop, since these
// functions are called from many places outside the component tree.

// Builds a per-department or master order receipt, in either thermal
// (80mm, for receipt printers) or A4 (full-page) layout.
function buildReceiptHtml(order: Order, type: "kitchen" | "counter" | "master", style: "thermal" | "a4"): string {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  const label = type === "kitchen" ? "KITCHEN ORDER" : type === "counter" ? "COUNTER ORDER" : "RECEIPT";
  const d = new Date(order.createdAt);
  const dateStr = d.toLocaleDateString(appSettings.locale);
  const timeStr = d.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" });
  const logoUrl = receiptBranding.logoUrl ? `${window.location.origin}${receiptBranding.logoUrl}` : `${window.location.origin}/logo.jpg`;
  const siteName = esc(receiptBranding.siteName || "MAXIS");
  const { blue, blueDark } = deriveShades(/^#[0-9a-f]{6}$/i.test(receiptBranding.themeColor) ? receiptBranding.themeColor : "#1a47a0");

  const addrLines = order.orderType === "delivery" && order.deliveryAddress?.street
    ? [order.deliveryAddress.street, order.deliveryAddress.area, order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `Apt ${order.deliveryAddress.apartment}` : ""].filter(Boolean)
    : [];
  const requestedAtLine = order.requestedTime ? `${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${formatRequestedTime(order.requestedTime)}` : "";

  if (style === "a4") {
    const rows = items.map((i) => `<tr>
      <td><b>${esc(i.name)}</b>${i.notes ? `<div class="note">${esc(i.notes)}</div>` : ""}</td>
      <td>${i.kg ? `${i.kg} kg` : "—"}</td>
      <td>${i.quantity ? `×${i.quantity}` : "—"}</td>
    </tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} — ${esc(order.ticketNumber)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e;line-height:1.5;padding:18mm}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid ${blueDark};margin-bottom:20px}
.hdr-left .shop{font-size:20px;font-weight:800;color:${blue}}.hdr-left .type{font-size:15px;font-weight:700;color:${blueDark};margin-top:4px}
.hdr-right{text-align:right}.logo{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid ${blueDark}}
.tnum{font-size:14px;font-weight:700;color:${blueDark};margin-top:6px}.dt{font-size:12px;color:#666;margin-top:2px}
.cbox{border:1px solid #c8d5ee;border-radius:8px;padding:14px 18px;margin-bottom:20px;background:#f4f7fd}
.clbl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6480;font-weight:700;margin-bottom:8px}
.cname{font-size:16px;font-weight:700;color:${blueDark}}.cline{font-size:13px;color:#333;margin-top:4px}
.del{color:${blue};font-weight:700}.ttag{color:${blueDark};font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:8px}thead tr{background:${blueDark}}
th{color:#fff;padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
td{padding:9px 12px;border-bottom:1px solid #e8eef7;font-size:13px;vertical-align:top}
tr:nth-child(even) td{background:#f8f9fc}tr:last-child td{border-bottom:none}
.note{font-size:11px;color:#666;margin-top:2px}
.footer{margin-top:40px;text-align:center;color:#888;font-size:12px;border-top:1px solid #e0e6f0;padding-top:12px}
</style></head><body>
<div class="hdr">
  <div class="hdr-left"><div class="shop">${siteName}</div><div class="type">${esc(label)}</div></div>
  <div class="hdr-right"><img class="logo" src="${logoUrl}" alt="${siteName}"><div class="tnum">${esc(order.ticketNumber)}</div><div class="dt">${dateStr} &nbsp; ${timeStr}</div></div>
</div>
<div class="cbox">
  <div class="clbl">Customer Details</div>
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cline">${esc(order.customerPhone)}</div>
  <div class="cline ${order.orderType === "delivery" ? "del" : ""}">${order.orderType === "delivery" ? "★ DELIVERY" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="cline">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="cline ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="cline">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="cline">Assigned to: <b>${esc(order.assignedTo)}</b></div>` : ""}
</div>
<table><thead><tr><th>Item</th><th>Kg</th><th>Qty</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="footer">Thank you for your order — ${siteName}</div>
</body></html>`;
  }

  // Thermal (80mm)
  const rows = items.map((i) => {
    const qty = [i.kg ? `${i.kg} kg` : "", i.quantity ? `×${i.quantity}` : ""].filter(Boolean).join("  ");
    return `<div class="item"><div class="iname">${esc(i.name)}</div><div class="isub">${esc(qty)}${i.notes ? `  — ${esc(i.notes)}` : ""}</div></div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} — ${esc(order.ticketNumber)}</title><style>
@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',Courier,monospace;font-size:12px;width:72mm;padding:4mm;margin:0 auto;line-height:1.5;color:#000}
.center{text-align:center}.sep{border:none;border-top:1px dashed #999;margin:6px 0}
.logo{width:52px;height:52px;border-radius:50%;object-fit:cover;margin-bottom:4px}
.shop{font-size:13px;font-weight:bold;color:${blue};letter-spacing:.5px}
.lbl{font-size:15px;font-weight:bold;letter-spacing:1px;color:${blueDark};margin-top:2px}
.tnum{font-size:12px;font-weight:bold;color:#333}.dt{font-size:11px;color:#555}
.cust{margin:4px 0}.cname{font-size:13px;font-weight:bold}
.cphone{font-size:12px;color:#333}.del{font-weight:bold;color:${blue}}
.addr{font-size:11px;color:#333;margin-top:2px}.ttag{font-size:11px;font-weight:bold;color:${blueDark};margin-top:2px}
.by{font-size:10px;color:#666;margin-top:2px}
.item{margin:5px 0}.iname{font-weight:bold}.isub{color:#444;font-size:11px;margin-top:1px}
.footer{font-size:11px;color:#555}
</style></head><body>
<div class="center">
  <img class="logo" src="${logoUrl}" alt="${siteName}">
  <div class="shop">${siteName}</div>
  <div class="lbl">${esc(label)}</div>
  <div class="tnum">${esc(order.ticketNumber)}</div>
  <div class="dt">${dateStr} &nbsp; ${timeStr}</div>
</div>
<hr class="sep">
<div class="cust">
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cphone">${esc(order.customerPhone)}</div>
  <div class="${order.orderType === "delivery" ? "del" : "cphone"}">${order.orderType === "delivery" ? "*** DELIVERY ***" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="addr">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="by">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="by">Assigned to: <b>${esc(order.assignedTo)}</b></div>` : ""}
</div>
<hr class="sep">
${rows}
<hr class="sep">
<div class="center footer">Thank you for your order</div>
</body></html>`;
}

// Escapes user-supplied text before interpolating into the HTML strings
// built throughout this file — every dynamic value in a receipt/summary
// goes through this to prevent a customer/product/supplier name from
// breaking the markup (or injecting script into the print window).
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Builds the printable weigh-in batch summary: grouped by supplier, then by
// item within each supplier (showing every individual line plus a per-item
// subtotal), then a final grand-total table across all suppliers. `heading`
// is overridden to "... — PREVIEW" when called from the non-finalizing
// preview button, so the printout is visually distinguishable from a real one.
function buildWeighInSummaryHtml(dateIso: string, lines: WeighInLine[], products: Product[], heading = "WEIGH-IN SUMMARY"): string {
  const siteName = esc(receiptBranding.siteName || "MAXIS");
  const logoUrl = receiptBranding.logoUrl ? `${window.location.origin}${receiptBranding.logoUrl}` : `${window.location.origin}/logo.jpg`;
  const { blue, blueDark } = deriveShades(/^#[0-9a-f]{6}$/i.test(receiptBranding.themeColor) ? receiptBranding.themeColor : "#1a47a0");
  const d = new Date(dateIso);
  const dateStr = d.toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" });

  const productName = (id: number) => products.find((p) => p.id === id)?.name ?? "—";

  // Section by supplier; within each supplier, group by item — each item shows its individual
  // weigh-in lines plus a per-item subtotal, then a supplier grand total at the bottom
  const bySupplier = new Map<number, { name: string; lines: WeighInLine[] }>();
  for (const l of lines) {
    const key = l.supplierId;
    const s = bySupplier.get(key) ?? { name: l.supplierName ?? "— Unknown supplier —", lines: [] };
    s.lines.push(l);
    bySupplier.set(key, s);
  }
  const supplierSections = [...bySupplier.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((supplier) => {
      const items = new Map<number, { productName: string; lines: WeighInLine[] }>();
      for (const l of supplier.lines) {
        const it = items.get(l.productId) ?? { productName: l.productName ?? productName(l.productId), lines: [] };
        it.lines.push(l);
        items.set(l.productId, it);
      }
      const itemBlocks = [...items.values()]
        .sort((a, b) => a.productName.localeCompare(b.productName))
        .map((it) => {
          const lineRows = [...it.lines]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((l) => `<tr><td></td><td>${esc(l.grade)}</td><td>${l.piecesReceived}</td><td>${l.weightKg.toFixed(2)}</td></tr>`)
            .join("");
          const itPieces = it.lines.reduce((sum, l) => sum + l.piecesReceived, 0);
          const itKg = it.lines.reduce((sum, l) => sum + l.weightKg, 0);
          return `<tr class="item-hdr"><td colspan="4">${esc(it.productName)}</td></tr>${lineRows}
<tr class="item-subtotal"><td colspan="2">${esc(it.productName)} subtotal</td><td>${itPieces}</td><td>${itKg.toFixed(2)}</td></tr>`;
        })
        .join("");
      const subPieces = supplier.lines.reduce((sum, l) => sum + l.piecesReceived, 0);
      const subKg = supplier.lines.reduce((sum, l) => sum + l.weightKg, 0);
      return `<h3 class="supplier-hdr">${esc(supplier.name)}</h3>
<table><thead><tr><th>Item</th><th>Grade</th><th>Pieces</th><th>Kg</th></tr></thead>
<tbody>${itemBlocks}
<tr class="totals"><td colspan="2">Supplier total</td><td>${subPieces}</td><td>${subKg.toFixed(2)}</td></tr>
</tbody></table>`;
    })
    .join("");

  // Per-item grand totals, regardless of supplier or grade
  const byItem = new Map<number, { productName: string; pieces: number; kg: number }>();
  for (const l of lines) {
    const it = byItem.get(l.productId) ?? { productName: l.productName ?? productName(l.productId), pieces: 0, kg: 0 };
    it.pieces += l.piecesReceived;
    it.kg += l.weightKg;
    byItem.set(l.productId, it);
  }
  const itemTotalRows = [...byItem.values()]
    .sort((a, b) => a.productName.localeCompare(b.productName))
    .map((it) => `<tr><td>${esc(it.productName)}</td><td>${it.pieces}</td><td>${it.kg.toFixed(2)}</td></tr>`)
    .join("");
  const grandPieces = lines.reduce((sum, l) => sum + l.piecesReceived, 0);
  const grandKg = lines.reduce((sum, l) => sum + l.weightKg, 0);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(heading)} — ${dateStr}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e;line-height:1.5;padding:18mm}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid ${blueDark};margin-bottom:20px}
.hdr-left .shop{font-size:20px;font-weight:800;color:${blue}}.hdr-left .type{font-size:15px;font-weight:700;color:${blueDark};margin-top:4px}
.hdr-right{text-align:right}.logo{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid ${blueDark}}
.dt{font-size:12px;color:#666;margin-top:2px}
.meta{font-size:13px;color:#333;margin-bottom:16px}
.supplier-hdr{font-size:14px;font-weight:700;color:${blueDark};margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid #c8d5ee}
.section-hdr{font-size:16px;font-weight:800;color:${blue};margin:28px 0 8px}
table{width:100%;border-collapse:collapse;margin-bottom:8px}thead tr{background:${blueDark}}
th{color:#fff;padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
td{padding:9px 12px;border-bottom:1px solid #e8eef7;font-size:13px;vertical-align:top}
tr:nth-child(even) td{background:#f8f9fc}
.item-hdr td{font-weight:700;color:${blueDark};background:#f4f7fd!important;padding-top:12px}
.item-subtotal td{font-style:italic;color:#555;border-top:1px solid #c8d5ee;background:#fff!important}
.totals td{font-weight:800;border-top:2px solid ${blueDark};background:#fff}
</style></head><body>
<div class="hdr">
  <div class="hdr-left"><div class="shop">${siteName}</div><div class="type">${esc(heading)}</div></div>
  <div class="hdr-right"><img class="logo" src="${logoUrl}" alt="${siteName}"><div class="dt">${dateStr}</div></div>
</div>
${supplierSections}
<h2 class="section-hdr">Item totals — all suppliers</h2>
<table><thead><tr><th>Item</th><th>Pieces</th><th>Kg</th></tr></thead>
<tbody>${itemTotalRows}
<tr class="totals"><td>Grand total</td><td>${grandPieces}</td><td>${grandKg.toFixed(2)}</td></tr>
</tbody></table>
</body></html>`;
}

// Opens a built HTML document for printing. Three paths:
// - Native Android app: an in-app overlay (see showInAppPrintPreview) —
//   window.open() there would launch a separate browser activity outside
//   the app's own back-stack, which the hardware back button can't escape.
// - Mobile browsers: open a new tab and auto-print (browsers handle their
//   own tab back-navigation fine, unlike the native app's WebView).
// - Desktop: a hidden iframe, so no extra tab/window is ever visible.
function printHtml(html: string): void {
  if (Capacitor.isNativePlatform()) {
    showInAppPrintPreview(html);
    return;
  }

  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile) {
    // Mobile browsers can't print from iframes — open receipt in a new tab and auto-print
    const printable = html.replace("</head>", '<script>window.addEventListener("load",function(){window.print()})<\/script></head>');
    const blob = new Blob([printable], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:800px;height:600px;border:none;visibility:hidden";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  iframe.contentWindow!.onafterprint = () => { document.body.removeChild(iframe); };
  setTimeout(() => { iframe.contentWindow?.print(); }, 150);
}

// Full-screen in-app preview with explicit Print and Close buttons — the
// native app's substitute for the browser tab used elsewhere, so leaving a
// print preview never requires the hardware back button (also wired up as
// a shortcut via closeActivePrintPreview + the backButton listener in App()).
function showInAppPrintPreview(html: string): void {
  const overlay = document.createElement("div");
  overlay.className = "print-preview-overlay";

  const toolbar = document.createElement("div");
  toolbar.className = "print-preview-toolbar";

  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.textContent = "Print / Save PDF";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "secondary";
  closeBtn.textContent = "Close";

  toolbar.append(printBtn, closeBtn);

  const iframe = document.createElement("iframe");
  iframe.className = "print-preview-frame";

  overlay.append(toolbar, iframe);
  document.body.appendChild(overlay);

  const doc = iframe.contentDocument!;
  doc.open(); doc.write(html); doc.close();

  const close = () => {
    document.body.removeChild(overlay);
    closeActivePrintPreview = null;
  };
  closeBtn.onclick = close;
  printBtn.onclick = () => iframe.contentWindow?.print();
  closeActivePrintPreview = close;
}

// Resolves which layout (thermal/A4) a given receipt type should use based
// on the admin's chosen printStyle, builds it, and either sends it straight
// to a named server-side printer (server/routes/print.ts) or falls back to
// the browser print flow if no printer is assigned (or the print API fails).
async function printReceipt(order: Order, type: "kitchen" | "counter" | "master", printStyle = "thermal", printerName = "") {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  if (items.length === 0) return;

  let resolved: "thermal" | "a4" = printStyle === "a4" ? "a4" : "thermal";
  if (printStyle === "master_a4") resolved = type === "master" ? "a4" : "thermal";
  if (printStyle === "dept_a4")   resolved = type !== "master" ? "a4" : "thermal";

  const html = buildReceiptHtml(order, type, resolved);

  if (printerName) {
    try { await api.print(printerName, html); return; } catch { /* fall through to browser print */ }
  }
  printHtml(html);
}

// Sends a throwaway test ticket to confirm a configured printer actually
// works, used by the "Test" button next to each printer assignment in Settings.
async function printTestPage(printerName: string): Promise<void> {
  const ts = new Date().toLocaleString(appSettings.locale);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',Courier,monospace;padding:5mm;font-size:12px;text-align:center;color:#000}
hr{border:none;border-top:1px dashed #999;margin:6px 0}
.big{font-size:16px;font-weight:bold}.small{font-size:10px;color:#555}
</style></head><body>
<div class="big">MAXIS KOT</div>
<div>--- TEST PRINT ---</div>
<hr>
<div class="small">${ts}</div>
<div class="small">Printer: ${printerName || "Browser dialog"}</div>
<hr>
<div>If you can read this,</div>
<div>the printer is working.</div>
</body></html>`;

  if (printerName) {
    try { await api.print(printerName, html); return; } catch { /* fall through to browser */ }
  }
  printHtml(html);
}

// ── Urgency helpers ───────────────────────────────────────────────────────────
// Classifies an order's requested pickup/delivery time into an urgency tier
// (0 = due within the hour, 4 = a week+ away) so the Queue can sort by what
// needs attention soonest and show a colored countdown badge.

const URGENCY = [
  { label: "Critical",  color: "#c41f1f" },
  { label: "Urgent",    color: "#d97706" },
  { label: "Today",     color: "#ca8a04" },
  { label: "Scheduled", color: "#1a47a0" },
  { label: "No rush",   color: "#6b7280" },
] as const;

function urgencyTier(requestedTime: string): number {
  if (!requestedTime) return 2; // no deadline → treat as "today"
  const requested = new Date(requestedTime);
  if (isNaN(requested.getTime())) return 2; // old "HH:mm" format
  const diffHours = (requested.getTime() - Date.now()) / 3_600_000;
  if (diffHours < 1)   return 0; // overdue or within 1 hour
  if (diffHours < 4)   return 1; // 1–4 hours
  if (diffHours < 24)  return 2; // today
  if (diffHours < 168) return 3; // within a week
  return 4;                       // 7+ days away
}

function urgencyInfo(requestedTime: string): { label: string; color: string } {
  const tier = urgencyTier(requestedTime);
  const { color } = URGENCY[tier];
  if (!requestedTime) return { label: "", color };
  const requested = new Date(requestedTime);
  if (isNaN(requested.getTime())) return { label: "", color };

  const diffMin = Math.floor((requested.getTime() - Date.now()) / 60_000);

  if (diffMin < 0) return { label: "Overdue", color: "#c41f1f" };
  if (diffMin < 60) return { label: `${diffMin}m`, color };
  if (diffMin < 240) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return { label: m > 0 ? `${h}h ${m}m` : `${h}h`, color };
  }
  if (tier <= 2) {
    return { label: requested.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" }), color };
  }
  return {
    label: requested.toLocaleDateString(appSettings.locale, { weekday: "short", day: "numeric", month: "short" }),
    color,
  };
}

function sortByUrgency(orders: Order[]): Order[] {
  return [...orders].sort((a, b) => {
    const diff = urgencyTier(a.requestedTime) - urgencyTier(b.requestedTime);
    if (diff !== 0) return diff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function formatRequestedTime(rt: string): string {
  if (!rt) return "";
  const d = new Date(rt);
  if (isNaN(d.getTime())) return rt; // old "HH:mm" format — show as-is
  return d.toLocaleString(appSettings.locale, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="empty">
      <ClipboardList size={42} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}

// Next stage in New → Received → Ready → Done, or null once already Done.
function nextDeptStatus(status: DeptStatus): DeptStatus | null {
  const i = deptStatusFlow.indexOf(status);
  return i === -1 ? null : (deptStatusFlow[i + 1] ?? null);
}

function calculateLineTotal(item: OrderItemInput) {
  if (!item.unitPrice || !item.kg) return null;
  return Number((item.kg * item.unitPrice).toFixed(2));
}

function tabTitle(tab: Tab) {
  return { orders: "New Order", queue: "Prep Queue", history: "Order History", products: "Stock", users: "Users", settings: "Settings", reports: "Reports", stockTake: "Stock Take", weighIn: "Weigh-In" }[tab];
}

function tabSubtitle(tab: Tab) {
  return {
    orders: "Capture customer details, weights, and cutting notes.",
    queue: "Move tickets through each stage.",
    history: "Review completed tickets.",
    settings: "System configuration.",
    products: "Manage stock items and prices.",
    users: "Manage staff accounts and PINs.",
    reports: "View and download orders for a date range.",
    stockTake: "Count on-hand stock and flag low items.",
    weighIn: "Log received stock by weight, batch by batch."
  }[tab];
}
