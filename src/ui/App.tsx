// Single-file React SPA for the whole client UI. One component per screen/
// panel (Login, OrderEntry, POSPanel, Queue, HistoryView, StockPanel
// (Products + StockTakePanel), WeighInPanel, PendingYieldsPanel, UsersPanel,
// SettingsPanel, ReportsPanel, StatisticsPanel, CrmPanel +
// CrmContactDetailPanel, LicenseStatusBanner), switched by the `tab` state
// in MainApp and gated per-role both here (nav visibility) and on the
// server (route middleware) — client-side gating is a UX nicety, never the
// actual security boundary. Camera-based barcode scanning (BarcodeAddModal,
// WeighLabelScanModal) is delegated to the useBarcodeScan hook, which picks
// a native Capacitor plugin on Android vs. the browser's own APIs
// elsewhere. Printing (buildReceiptHtml / buildWeighInSummaryHtml /
// printHtml) lives at the bottom as plain functions, not components, since
// they build a full standalone HTML document string for a separate print
// tab/iframe rather than rendering into this app's own DOM.
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import {
  ArrowDown,
  ArrowUp,
  BarChart2,
  TrendingUp,
  ClipboardList,
  FileDown,
  History,
  LogOut,
  Mail,
  Minus,
  MessageCircle,
  Moon,
  Package,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Save,
  ScanLine,
  Scissors,
  Settings,
  ShoppingCart,
  Sun,
  Tag,
  Trash2,
  Users,
  Weight,
  X
} from "lucide-react";
import JsBarcode from "jsbarcode";
import { appSettings } from "../shared/settings";
import { parseWeighBarcode, buildWeighBarcode } from "../shared/weighBarcode";
import { generateInternalBarcode } from "../shared/internalBarcode";
import { flattenBatch, totalBatchCount, placeOnSheets, type LabelBatchEntry } from "../shared/labelBatch";
import { calculateLineTotal, buildCartLine } from "../shared/posCart";
import { initScanBuffer, feedScanBuffer } from "../shared/scanBuffer";
import type {
  CreateOrderInput,
  DeliveryAddress,
  Department,
  DeptStatus,
  Grade,
  ItemSalesStat,
  ItemStockMovementStat,
  StatisticsOverview,
  MarginOverview,
  PendingYieldConversion,
  Order,
  OrderItemInput,
  Product,
  ProductInput,
  ProductStockRow,
  StockLocation,
  Supplier,
  User,
  UserInput,
  WeighInBatchSummary,
  WeighInLine,
  CrmContact,
  CrmContactDetail,
  CrmMessage,
  ConsentStatus,
  EmailSubscriber,
  LabelFormat,
  LabelFormatInput,
  LabelData,
  DiscoveredPrinter,
  UnitDefault
} from "../shared/types";
import { api, assetUrl } from "./api";
import { useBarcodeScan } from "./useBarcodeScan";
import { iconSwitcher, type IconVariant } from "./iconSwitcher";
import { applyTheme, applyThemeMode, deriveShades, initThemeMode, ThemeMode } from "./theme";
import { tokenStorage } from "./tokenStorage";

type Tab = "orders" | "pos" | "queue" | "history" | "products" | "users" | "settings" | "reports" | "weighIn" | "statistics" | "crm" | "consolidate" | "printLabels";

// Applied at module load (before React's first render) so there's no flash
// of the wrong theme — reads the stored preference (or system default).
initThemeMode();

const deptStatusFlow: DeptStatus[] = ["New", "Received", "Ready", "Done"];
const emptyLine: OrderItemInput = { productId: null, name: "", kg: null, quantity: null, notes: "", unitPrice: null, lineTotal: null, wantedPrice: null, department: "counter" };
const EMPTY_PRODUCT: ProductInput = { name: "", category: "", unitDefault: "kg", pricePerUnit: null, prepNotes: "", department: "counter", lowStockThreshold: null, barcode: null, itemCode: null, isRawIntake: 0 };

// Sticker label print preferences (size/copies/which fields show) — a
// per-device convenience, not shop-wide config, so plain localStorage
// rather than the server settings table: whoever's printing labels on
// this particular till/device just wants their last choice remembered.
const LABEL_PREFS_KEY = "nemenchpos-label-prefs";
const DEFAULT_LABEL_PREFS: LabelPrefs = { size: "50x30", copies: 1, showPrice: true, showCategory: false, showCost: false };
function loadLabelPrefs(): LabelPrefs {
  try {
    const raw = localStorage.getItem(LABEL_PREFS_KEY);
    if (!raw) return DEFAULT_LABEL_PREFS;
    return { ...DEFAULT_LABEL_PREFS, ...(JSON.parse(raw) as Partial<LabelPrefs>) };
  } catch {
    return DEFAULT_LABEL_PREFS;
  }
}

const currency = new Intl.NumberFormat(appSettings.locale, { style: "currency", currency: appSettings.currency });

// ── Auth wrapper ──────────────────────────────────────────────────────────────

// Updates the browser tab title/favicon to match the admin-configured branding.
function applyBranding(siteName: string, logoUrl: string) {
  document.title = siteName || "NemenchPos";
  document.querySelector('link[rel="icon"]')?.setAttribute("href", assetUrl(logoUrl || "/logo.jpg"));
}

// Plain module cache so receipt-building functions (outside the React tree) can
// read live branding without threading it through every print call site.
let receiptBranding = { siteName: "NemenchPos", logoUrl: "", themeColor: "", vatRegistered: false, vatNumber: "", businessAddress: "", publicBaseUrl: "" };

// For the PRINT path only: embed the logo as a base64 data URI rather than
// referencing it by URL, so the print preview/PDF render correctly even
// with a flaky connection to this server. Data URIs are deliberately NOT
// used for email (see buildReceiptHtml's forEmail branch below) — major
// mail clients (Gmail, Outlook) strip inline data: URIs from received HTML
// as an anti-spam measure, so a technically-valid data URI still never
// renders for a real recipient. Fetched once whenever the logo actually
// changes and cached here.
let logoDataUri: string | null = null;
let logoDataUriFor = "";

async function refreshLogoDataUri(): Promise<void> {
  const target = receiptBranding.logoUrl || "/logo.jpg";
  if (logoDataUriFor === target && logoDataUri) return;
  try {
    const res = await fetch(assetUrl(target));
    // A stale/deleted uploaded logo (e.g. after a restore) 404s against
    // express.static, but the server's SPA catch-all then serves
    // index.html for that path with a 200 — without checking res.ok AND
    // the content-type, that HTML page would get base64-encoded and used
    // as the <img> src, producing a permanently broken image in both the
    // print preview and every email, not just an occasional race.
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return;
    const blob = await res.blob();
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read logo blob"));
      reader.readAsDataURL(blob);
    });
    logoDataUri = dataUri;
    logoDataUriFor = target;
  } catch {
    // Leave the previous cached value (possibly still null) in place —
    // buildReceiptHtml's URL fallback covers this case.
  }
}

// Callers that are about to build a receipt for something other than an
// immediate same-device print (email in particular, where the plain-URL
// fallback is useless to a recipient off the LAN) await this first, so a
// slow first fetch on a freshly-loaded page can't lose the race and fall
// back to a URL the recipient will never be able to reach.
async function ensureLogoDataUri(): Promise<void> {
  if (logoDataUri && logoDataUriFor === (receiptBranding.logoUrl || "/logo.jpg")) return;
  await refreshLogoDataUri();
}

function setReceiptBranding(patch: Partial<typeof receiptBranding>) {
  receiptBranding = { ...receiptBranding, ...patch };
  if (patch.logoUrl !== undefined) void refreshLogoDataUri();
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
  const [branding, setBranding] = useState({ siteName: "NemenchPos", logoUrl: "" });
  // initThemeMode() already applied the stored/system preference to <html>
  // before this component's first render (see module scope above) — this
  // state just needs to agree with it so the toggle button shows the right icon.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => (document.documentElement.getAttribute("data-theme") as ThemeMode) || "light");
  // The user's own choice (saved server-side to their account) always wins
  // over the per-device fallback, so the same login shows the same theme on
  // any terminal.
  const applyUserThemeMode = (user: User) => {
    if (user.themeMode === "light" || user.themeMode === "dark") {
      applyThemeMode(user.themeMode);
      setThemeMode(user.themeMode);
    }
  };
  const toggleThemeMode = () => {
    const next: ThemeMode = themeMode === "dark" ? "light" : "dark";
    applyThemeMode(next);
    setThemeMode(next);
    api.auth.setThemeMode(next)
      .then(({ token }) => tokenStorage.set(token))
      .catch(() => undefined);
  };

  // Validate any stored token against the server on load, rather than
  // trusting it blindly — also picks up server-side role changes.
  useEffect(() => {
    const token = tokenStorage.get();
    if (!token) { setBooting(false); return; }
    api.auth.me()
      .then((user) => { setCurrentUser(user); applyUserThemeMode(user); })
      .catch(() => tokenStorage.clear())
      .finally(() => setBooting(false));
  }, []);

  // Branding/theme apply on boot — works whether logged in or not, so the login screen is branded too
  useEffect(() => {
    api.settings.public().then((s) => {
      setBranding({ siteName: s.siteName, logoUrl: s.logoUrl });
      applyBranding(s.siteName, s.logoUrl);
      setReceiptBranding({ siteName: s.siteName, logoUrl: s.logoUrl, themeColor: s.themeColor, vatRegistered: s.vatRegistered, vatNumber: s.vatNumber, businessAddress: s.businessAddress, publicBaseUrl: s.publicBaseUrl });
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
  if (!currentUser) return <LoginScreen onLogin={(user) => { setCurrentUser(user); applyUserThemeMode(user); }} branding={branding} />;
  return <MainApp currentUser={currentUser} onLogout={logout} branding={branding} onBrandingChange={setBranding} themeMode={themeMode} onToggleTheme={toggleThemeMode} />;
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
          <img src={assetUrl(branding.logoUrl || "/logo.jpg")} alt={branding.siteName} className="login-logo" />
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

// Purely informational — shows license/suspension status reported by the
// multi-tenant control plane (see server/controlPlaneSync.ts), for the
// business owner to notice and act on. One-shot fetch on mount (matches
// api.settings.public()'s one-shot call at boot — this doesn't need to be
// any more real-time than a page load/tab switch already provides), never
// throws into the UI on failure, renders nothing for active/trial status.
// Dismissible for the current page view; reappears on next load if the
// underlying status hasn't changed. Deliberately makes no calls into any
// order/product/print flow — see MainApp's role+tab gating on where this
// is even mounted, which is the actual guarantee it never touches POS/
// kitchen behavior, not anything in this component itself.
function LicenseStatusBanner() {
  const [status, setStatus] = useState<{ licenseStatus: string; gracePeriodEndsAt: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api.settings.licenseStatus().then(setStatus).catch(() => undefined);
  }, []);

  if (!status || dismissed) return null;
  if (status.licenseStatus !== "pending_suspension" && status.licenseStatus !== "suspended") return null;

  const daysLeft = status.gracePeriodEndsAt
    ? Math.max(0, Math.ceil((new Date(status.gracePeriodEndsAt).getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <div className={`license-banner ${status.licenseStatus === "suspended" ? "license-banner-suspended" : ""}`}>
      <span>
        {status.licenseStatus === "suspended"
          ? "Account suspended — contact support to restore access."
          : `Account pending suspension — ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining. Contact support to resolve this.`}
      </span>
      <button type="button" className="icon-button" onClick={() => setDismissed(true)} aria-label="Dismiss"><X size={16} /></button>
    </div>
  );
}

// Bridge so plain functions living outside the component tree (printReceipt,
// printTestPage — called from many places: TicketCard, HistoryView, Queue,
// Settings, none of which have MainApp's own notify() in scope) can still
// surface a toast. MainApp registers the real setter on mount; before that
// (or if MainApp never mounted) this is just a no-op, same graceful-no-op
// posture as every other "optional dependency not wired up yet" spot in
// this app. This is specifically what was missing before: printReceipt and
// printTestPage used to catch a failed server-side print and silently fall
// back to the browser print dialog with zero indication anything went
// wrong — so a broken/misconfigured named printer looked exactly like a
// working one from the staff member's side, they'd just quietly get a
// browser print dialog instead of paper coming out of the till printer.
let globalToast: ((text: string, tone: "info" | "error") => void) | null = null;
function showToast(text: string, tone: "info" | "error" = "info") {
  globalToast?.(text, tone);
}

// A short, synthesized beep (Web Audio API — no audio file, no external
// call) confirming a barcode scan was received and processed, so a
// cashier who isn't watching the screen closely still gets immediate
// feedback. Silently does nothing if the Web Audio API is unavailable or
// blocked (e.g. before any user interaction on some browsers) — the
// visual flash on the till slip line (see flashLineIndex in POSPanel)
// still confirms it either way, this is a bonus, not the only cue.
function playScanBeep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch { /* audio unavailable — the visual flash still confirms the scan */ }
}

// Print-behavior preferences — same module-level-cache reasoning as
// receiptBranding above: printReceipt/printTestPage are plain functions
// called from many places outside the component tree (TicketCard,
// HistoryView, Queue, Settings, PrintLabelsPanel), and unlike
// printStyle/printerName (which vary per call site — different printer
// per department — so callers already resolve and pass those explicitly),
// these two are uniform, global preferences that apply the same way to
// every print action, which is exactly what this cache is for.
let printPrefs = { forcePreview: false, colorMode: "color" as "color" | "grayscale" };
function setPrintPrefs(patch: Partial<typeof printPrefs>) {
  printPrefs = { ...printPrefs, ...patch };
}

// Injects a grayscale filter into a generated receipt/label/label-sheet
// document's own <style> block when the admin has selected black-and-white
// printing — a single point of enforcement that every print path (the
// browser print-preview dialog AND the server-side headless-Chrome PDF
// route, see server/routes/print.ts) both honor automatically, since both
// are real rendering engines applying the exact same CSS rather than two
// separate mechanisms that could drift.
function applyColorMode(html: string): string {
  if (printPrefs.colorMode !== "grayscale") return html;
  return html.replace("</style>", "body{filter:grayscale(100%)}</style>");
}

// ── Main app ──────────────────────────────────────────────────────────────────

// The logged-in shell: sidebar nav (gated per role) + whichever panel the
// current tab selects. Owns the shared data (products/orders) that multiple
// panels need, refreshed on mount and lightly polled while on the Queue tab.
function MainApp({ currentUser, onLogout, branding, onBrandingChange, themeMode, onToggleTheme }: { currentUser: User; onLogout: () => void; branding: { siteName: string; logoUrl: string }; onBrandingChange: (b: { siteName: string; logoUrl: string }) => void; themeMode: ThemeMode; onToggleTheme: () => void }) {
  // stock_taker gets a completely separate, minimal nav (Stock Take +
  // Weigh-In only) — everything else below the ternary is for other roles.
  const isStockTaker = currentUser.role === "stock_taker";
  const [tab, setTab] = useState<Tab>(isStockTaker ? "products" : currentUser.role === "kitchen" || currentUser.role === "counter" ? "queue" : "orders");
  const [products, setProducts] = useState<Product[]>([]);
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  const [autoPrint, setAutoPrint] = useState(false);
  const [printStyle, setPrintStyle] = useState("thermal");
  const [printerMap, setPrinterMap] = useState({ kitchen: "", counter: "", master: "", label: "" });
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
      setPrinterMap({ kitchen: s.kitchenPrinter ?? "", counter: s.counterPrinter ?? "", master: s.masterPrinter ?? "", label: s.labelPrinter ?? "" });
      setPrintPrefs({ forcePreview: s.printForcePreview === "true", colorMode: s.printColorMode === "grayscale" ? "grayscale" : "color" });
    }).catch(() => undefined);
  }, []);

  useEffect(() => { void refresh(); }, []);

  // Fetch history only when the user actually opens the history tab
  useEffect(() => {
    if (tab === "history") {
      api.orders.list("history").then(setHistoryOrders).catch(() => undefined);
    }
  }, [tab]);

  useEffect(() => {
    const id = setInterval(() => void pollActive(), 5000);
    return () => clearInterval(id);
  }, []);

  const notify = (text: string, tone: "info" | "error" = "info") => {
    setMessage(text);
    setMessageTone(tone);
    window.setTimeout(() => setMessage(""), tone === "error" ? 6000 : 2500);
  };

  // Registers the module-level bridge (see globalToast/showToast above the
  // component) so printReceipt/printTestPage — plain functions with no
  // access to this component's own notify — can still show a toast.
  useEffect(() => {
    globalToast = notify;
    return () => { globalToast = null; };
  }, []);

  // Confirmed because an accidental tap (easy on the compact mobile/app nav)
  // would otherwise drop the user straight back to the login screen mid-task.
  const confirmLogout = () => {
    if (window.confirm("Sign out?")) onLogout();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={assetUrl(branding.logoUrl || "/logo.jpg")} alt={branding.siteName} className="brand-logo" />
          <div>
            <strong>{branding.siteName}</strong>
            <span>{currentUser.name} · {{ admin: "Admin", cashier: "Cashier", master_cashier: "Master Cashier", kitchen: "Kitchen", counter: "Counter", stock_taker: "Stock Taker" }[currentUser.role]}</span>
          </div>
        </div>
        <nav>
          {isStockTaker ? (
            <>
              <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}><Package size={18} /><span>Stock</span></button>
              <button className={tab === "weighIn" ? "active" : ""} onClick={() => setTab("weighIn")}><Weight size={18} /><span>Weigh-In</span></button>
            </>
          ) : (
            <>
              {(currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier") && (
                <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}><Plus size={18} /><span>New</span></button>
              )}
              {(currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier") && (
                <button className={tab === "pos" ? "active" : ""} onClick={() => setTab("pos")}><ShoppingCart size={18} /><span>POS</span></button>
              )}
              <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}><ClipboardList size={18} /><span>Queue</span></button>
              <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={18} /><span>History</span></button>
              {(currentUser.role === "kitchen" || currentUser.role === "counter" || currentUser.role === "cashier" || currentUser.role === "admin") && (
                <button className={tab === "consolidate" ? "active" : ""} onClick={() => setTab("consolidate")}><ScanLine size={18} /><span>Consolidate</span></button>
              )}
              {(currentUser.role === "counter" || currentUser.role === "admin") && (
                <button className={tab === "printLabels" ? "active" : ""} onClick={() => setTab("printLabels")}><Tag size={18} /><span>Print Labels</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>
                  <Package size={18} /><span>Stock</span>
                  {lowStockCount > 0 && <span className="badge-count">{lowStockCount}</span>}
                </button>
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
              {currentUser.role === "admin" && (
                <button className={tab === "statistics" ? "active" : ""} onClick={() => setTab("statistics")}><TrendingUp size={18} /><span>Statistics</span></button>
              )}
              {currentUser.role === "admin" && (
                <button className={tab === "crm" ? "active" : ""} onClick={() => setTab("crm")}><MessageCircle size={18} /><span>CRM</span></button>
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
          <button
            type="button" className="icon-button secondary theme-toggle"
            onClick={onToggleTheme}
            title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle dark mode"
          >
            {themeMode === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>

        {message && <div className={`toast${messageTone === "error" ? " toast-error" : ""}`}>{message}</div>}

        {/* Admin-only, and hidden on POS/Queue even for an admin using those
            tabs themselves — this is informational for the business owner,
            never something a cashier or kitchen screen should show or be
            distracted by. See LicenseStatusBanner. */}
        {currentUser.role === "admin" && tab !== "pos" && tab !== "queue" && <LicenseStatusBanner />}

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
        {tab === "pos" && (currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier") && (
          <POSPanel
            products={products}
            printerMap={printerMap}
            currentUser={currentUser}
            onCompleted={async (order) => { notify(`Sale ${order.ticketNumber} complete`); await refresh(); }}
          />
        )}
        {tab === "queue" && <Queue orders={activeOrders} currentUser={currentUser} onChanged={refresh} printStyle={printStyle} printerMap={printerMap} />}
        {tab === "history" && <HistoryView orders={historyOrders} printStyle={printStyle} printerMap={printerMap} />}
        {tab === "consolidate" && (currentUser.role === "kitchen" || currentUser.role === "counter" || currentUser.role === "cashier" || currentUser.role === "admin") && (
          <ConsolidationPanel printStyle={printStyle} printerMap={printerMap} />
        )}
        {tab === "printLabels" && (currentUser.role === "counter" || currentUser.role === "admin") && <PrintLabelsPanel products={products} printerName={printerMap.label} />}
        {tab === "products" && (currentUser.role === "admin" || isStockTaker) && <StockPanel products={products} currentUser={currentUser} onChanged={refresh} />}
        {tab === "weighIn" && (currentUser.role === "admin" || isStockTaker) && <WeighInPanel products={products} currentUser={currentUser} onChanged={refresh} />}
        {tab === "users" && currentUser.role === "admin" && <UsersPanel />}
        {tab === "settings" && currentUser.role === "admin" && (
          <SettingsPanel autoPrint={autoPrint} onAutoPrintChange={setAutoPrint} printStyle={printStyle} onPrintStyleChange={setPrintStyle} printerMap={printerMap} onPrinterMapChange={setPrinterMap} branding={branding} onBrandingChange={onBrandingChange} />
        )}
        {tab === "reports" && currentUser.role === "admin" && <ReportsPanel />}
        {tab === "statistics" && currentUser.role === "admin" && <StatisticsPanel />}
        {tab === "crm" && currentUser.role === "admin" && <CrmPanel />}
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
  // Independent of customerPhone above — an email order-ready notification
  // (see server/email/) is entirely separate from the WhatsApp/CRM system,
  // never required, only sent if provided.
  const [customerEmail, setCustomerEmail] = useState("");
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

  // A "wanted price" (e.g. customer asks for "R100 of mince") stands in for a
  // weight the cashier hasn't taken yet. Kg is estimated from it up front so
  // the ticket shows something sensible, but stays freely editable/clearable
  // afterward — the actual weight can be confirmed later at the scale.
  const setWantedPrice = (index: number, value: string, unitPrice: number | null | undefined) => {
    const wantedPrice = value ? Number(value) : null;
    const estimatedKg = wantedPrice && unitPrice ? Number((wantedPrice / unitPrice).toFixed(3)) : null;
    setLine(index, { wantedPrice, kg: estimatedKg });
  };

  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);

  // A scanned/quick-created product only tells us item + price, not
  // kg/quantity — appended as a new line (replacing a still-blank first
  // line rather than piling up empties) for the cashier to fill in weight/qty.
  const addLineFromBarcode = (p: Product, wantedPrice?: number) => {
    // A scale-embedded weigh-barcode already tells us the final price for
    // this specific label — same "wanted price" convention as typing one
    // in by hand, so kg is estimated from it the same way.
    const estimatedKg = wantedPrice && p.pricePerUnit ? Number((wantedPrice / p.pricePerUnit).toFixed(3)) : null;
    const newLine: OrderItemInput = { productId: p.id, name: p.name, kg: estimatedKg, quantity: null, notes: p.prepNotes, unitPrice: p.pricePerUnit, lineTotal: null, wantedPrice: wantedPrice ?? null, department: p.department };
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
      customerEmail: customerEmail.trim() || null,
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
      setCustomerName(""); setCustomerPhone(""); setCustomerEmail(""); setOrderType("pickup");
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
        <label>Email <span className="settings-hint">(optional — for order-ready email updates)</span>
          <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
        </label>
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
              Wanted price (R) <span className="optional-hint">(optional — instead of a weight)</span>
              <input type="number" min="0" step="0.01" placeholder="e.g. 100" value={item.wantedPrice ?? ""} onChange={(e) => setWantedPrice(index, e.target.value, item.unitPrice)} />
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

// ── POS (Point of Sale) ──────────────────────────────────────────────────────
// Base layer for a walk-in checkout screen: a touch-friendly product grid on
// one side, a running cart/receipt preview on the other. Distinct from
// OrderEntry (which builds a kitchen-prep ticket with customer/delivery
// details) — a POS sale is already-paid-for items handed over on the spot,
// so it's created via completeImmediately (see createOrder) and lands
// straight in History, never the prep Queue. Gated to the same roles as
// "New Order" (admin/cashier/master_cashier), both in MainApp's nav and here.
function POSPanel({ products, printerMap, currentUser, onCompleted }: { products: Product[]; printerMap: Record<string, string>; currentUser: User; onCompleted: (order: Order) => void }) {
  // Keyed per-user (not just per-device) so switching cashiers on a shared
  // terminal can't hand one cashier's in-progress sale to the next — an
  // abandoned cart silently reappearing on someone else's till would be a
  // real "wrong person got charged" risk, not just an inconvenience.
  const posSaleKey = `nemenchpos-pos-sale-${currentUser.id}`;
  const loadSavedSale = (): { cart: OrderItemInput[]; discount: number } => {
    try {
      const raw = localStorage.getItem(posSaleKey);
      if (!raw) return { cart: [], discount: 0 };
      const parsed = JSON.parse(raw) as { cart?: OrderItemInput[]; discount?: number };
      return { cart: parsed.cart ?? [], discount: parsed.discount ?? 0 };
    } catch {
      return { cart: [], discount: 0 };
    }
  };

  const [search, setSearch] = useState("");
  // Which category's product list is expanded below the category-button
  // row — null (the idle default) shows no product list at all, only the
  // scan panel/quick picks/category buttons themselves. This is what
  // keeps the default screen state minimal instead of always rendering
  // the full catalog (see categoryProducts below, which is now only
  // computed/rendered while a category is actually expanded).
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [quickPicks, setQuickPicks] = useState<Product[]>([]);
  const [scanError, setScanError] = useState("");
  const [cart, setCart] = useState<OrderItemInput[]>(() => loadSavedSale().cart);
  const [discount, setDiscount] = useState(() => loadSavedSale().discount);
  // Which cart line the numeric keypad is currently editing — set
  // automatically to whichever line was just added (see the effect
  // below), or by tapping a line in the till slip. null means nothing's
  // selected (keypad shows disabled/blank).
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [keypadValue, setKeypadValue] = useState("");
  // Briefly highlighted till-slip line index — the visual half of the
  // "a scan was received and processed" confirmation (see handleScan/
  // playScanBeep), since staff scanning items aren't necessarily looking
  // at the screen closely enough to notice a new line appearing on its own.
  const [flashLineIndex, setFlashLineIndex] = useState<number | null>(null);
  // Set right before a scan-triggered addToCart call, consumed (and
  // cleared) by the cart-growth effect below — lets that effect tell a
  // scan-add apart from a manual tile tap without needing to plumb an
  // extra argument through setCart's updater.
  const scanFlashPending = useRef(false);
  // Opens a dedicated modal to enter/change the discount, rather than a
  // plain always-visible number field — a bare inline input next to a
  // dozen other numbers on the receipt is too easy to miss as an actual
  // feature (same reasoning as why Clear Sale became a real button).
  const [discountModalOpen, setDiscountModalOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | null>(null);
  const [cashTendered, setCashTendered] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Only actually required above the R5,000 full-tax-invoice threshold
  // (see needsFullInvoice below) — otherwise unused and left blank.
  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  // Entirely optional CRM contact capture — blank stays blank forever, never
  // required to check out, never validated client-side beyond a plain text
  // field. See db.createOrder's customerNumber handling: a filled-in number
  // resolves-or-creates a crm_contacts row server-side; nothing here blocks
  // or slows down an ordinary cash sale.
  const [customerNumber, setCustomerNumber] = useState("");
  // Same posture as customerNumber above, but independent of it — an
  // email order-ready/payment-received notification (see server/email/)
  // is entirely separate from the WhatsApp/CRM system, so this is captured
  // on its own, not tied to whether a phone number was also given.
  const [customerEmail, setCustomerEmail] = useState("");
  // Index of the line awaiting PIN confirmation before it's actually
  // removed — a fat-finger tap on the trash icon during a live sale
  // shouldn't be enough on its own to drop an item.
  const [pendingRemoveIndex, setPendingRemoveIndex] = useState<number | null>(null);
  // Same guard on wiping the whole sale — one stray tap on Clear Sale
  // shouldn't be able to drop an entire in-progress cart.
  const [pendingClearSale, setPendingClearSale] = useState(false);
  const [reorderScanOpen, setReorderScanOpen] = useState(false);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState("");
  // Bumped on a failed lookup so <ScanCodeModal key={reorderScanAttempt}>
  // fully remounts (and its camera restarts) rather than sitting dead —
  // the underlying useBarcodeScan hook only (re)starts scanning when its
  // component mounts/its `active` prop flips, neither of which happens on
  // its own just because an error appeared while the modal stayed open.
  const [reorderScanAttempt, setReorderScanAttempt] = useState(0);

  // Scans a past order's printed barcode and appends its line items to the
  // current cart — "reorder" for a repeat customer, or a fast way to redo
  // an accidental full-sale reprint. Deliberately only copies items, not
  // the source order's customer/discount/payment details: this is a new,
  // independent sale, not a duplicate of the old one's whole identity.
  const reorderFromTicket = async (ticketNumber: string) => {
    setReorderBusy(true); setReorderError("");
    try {
      const order = await api.orders.getByTicket(ticketNumber);
      const items: OrderItemInput[] = order.items.map((i) => ({
        productId: i.productId, name: i.name, kg: i.kg, quantity: i.quantity,
        notes: i.notes, unitPrice: i.unitPrice, lineTotal: i.lineTotal, wantedPrice: i.wantedPrice, department: i.department
      }));
      setCart((cur) => [...cur, ...items]);
      setReorderScanOpen(false);
    } catch (err) {
      setReorderError(err instanceof Error ? err.message : "Couldn't find that order");
      setReorderScanAttempt((n) => n + 1);
    } finally {
      setReorderBusy(false);
    }
  };

  // Survives switching tabs away from POS and back (this component
  // unmounts on tab switch, which would otherwise wipe React state), and
  // even a full page reload/app restart — an in-progress till sale
  // shouldn't evaporate because someone bumped the wrong nav button.
  useEffect(() => {
    if (cart.length === 0 && discount === 0) { localStorage.removeItem(posSaleKey); return; }
    localStorage.setItem(posSaleKey, JSON.stringify({ cart, discount }));
  }, [cart, discount]); // eslint-disable-line react-hooks/exhaustive-deps

  // "All" deliberately excluded — there's no idle-state "show everything"
  // button anymore (see LAYOUT SPEC: category → filtered list only on
  // demand, catalog never rendered whole).
  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category || "Other"))).sort(), [products]);

  // Fixed hue order (never reassigned by filtering/sorting elsewhere) so a
  // category's color stays put — the 9th+ category folds into a neutral
  // "other" badge rather than wrapping back onto an already-used hue.
  const categoryBadgeClass = (cat: string) => {
    const idx = categories.indexOf(cat);
    return idx >= 0 && idx < 8 ? `pos-cat-${idx + 1}` : "pos-cat-other";
  };

  // Quick visual identifier per tile — initials of the product name (up to
  // 2 letters), badge-colored by category so items are still scannable at
  // a glance even with the name text right below it.
  const initials = (name: string) => {
    const words = name.trim().split(/\s+/);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  };

  // Only computed/rendered while a category is actually expanded — the
  // idle screen never mounts a product grid at all (see expandedCategory).
  const categoryProducts = useMemo(() => {
    if (!expandedCategory) return [];
    return products.filter((p) => (p.category || "Other") === expandedCategory).sort((a, b) => a.name.localeCompare(b.name));
  }, [products, expandedCategory]);

  // Manual-fallback search matches — a small results list under the scan
  // panel, same "search reveals results, nothing shown otherwise" pattern
  // used by the product search elsewhere in this app (Print Labels, Stock).
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? "").includes(q) || (p.itemCode ?? "").includes(q))
      .slice(0, 8);
  }, [products, search]);

  useEffect(() => {
    api.products.quickPicks().then(setQuickPicks).catch(() => undefined);
  }, []);

  // Auto-selects whichever line was just appended (scan, tile tap, or
  // search) so the numeric keypad is immediately ready to accept a real
  // weight/quantity for it — the natural next step at a real till right
  // after an item lands on the slip. Only fires on growth, not on every
  // cart change (editing/removing a line shouldn't yank the selection
  // away from what the cashier is actively working on).
  const prevCartLength = useRef(cart.length);
  useEffect(() => {
    if (cart.length > prevCartLength.current) {
      const newIndex = cart.length - 1;
      setSelectedLine(newIndex);
      const line = cart[newIndex];
      setKeypadValue(line ? String(line.kg ?? line.quantity ?? "") : "");
      if (scanFlashPending.current) {
        setFlashLineIndex(newIndex);
        window.setTimeout(() => setFlashLineIndex(null), 700);
      }
    }
    scanFlashPending.current = false;
    prevCartLength.current = cart.length;
  }, [cart]);

  // Tapping a tile either bumps an existing line's qty (count-priced items,
  // where "tap 3 times" is the natural touch gesture) or adds a new line
  // (weight-priced items, where the weight still needs confirming via the
  // keypad below) rather than trying to guess a sensible default kg.
  // `wantedPrice`, when given (a real scale weigh-label was scanned — see
  // resolveScannedProduct), pre-fills the actual weight that label was for
  // instead of a generic 1kg placeholder. Blocked entirely for a product
  // with no recorded cost price — the server enforces this too (see
  // createOrder's cost check), this is just the earlier, friendlier stop.
  const addToCart = (p: Product, wantedPrice?: number) => {
    if (p.currentCost == null) { setError(`"${p.name}" has no cost price set — add one in Stock before selling it.`); return; }
    setError(""); setScanError("");
    setCart((cur) => {
      if (p.unitDefault === "qty") {
        const idx = cur.findIndex((i) => i.productId === p.id);
        if (idx >= 0) {
          const next = [...cur];
          const quantity = (next[idx].quantity ?? 0) + 1;
          next[idx] = { ...next[idx], quantity, lineTotal: calculateLineTotal({ ...next[idx], quantity }) };
          return next;
        }
      }
      // buildCartLine (shared/posCart.ts) is the SAME function a manual
      // tile tap and a barcode scan both call — no separate "scan add"
      // code path that could drift from what tapping a tile does.
      return [...cur, buildCartLine(p, wantedPrice)];
    });
  };

  // Global scanner-wedge capture: a hardware barcode scanner (USB or
  // Bluetooth HID — both present to the OS as a plain keyboard) types its
  // decoded digits as very fast, back-to-back keystrokes followed by
  // Enter — nothing a human types matches that cadence, so
  // feedScanBuffer (shared/scanBuffer.ts, unit-tested there against both
  // fast and slow timing) distinguishes a real scan from ordinary typing
  // without needing focus to sit in any particular field. Skipped while
  // focus is in a genuine free-text field (buyer name/address/customer
  // contact details) so a scan can never corrupt those, but works whether
  // focus is on the search box, nowhere in particular, or the page body —
  // exactly the "doesn't need to sit in a specific field" behavior asked
  // for.
  useEffect(() => {
    const state = initScanBuffer();

    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inProtectedField = active instanceof HTMLElement
        && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
        && active.id !== "pos-scan-search";
      if (inProtectedField) { state.buffer = ""; return; }

      const completed = feedScanBuffer(state, e.key, Date.now());
      if (completed) void handleScan(completed);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [products]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared by the global scanner-wedge listener and the manual search
  // box's "Enter" fallback — a weigh-label decodes to an itemCode + the
  // actual price that label was printed for (see parseWeighBarcode); a
  // plain product barcode is looked up as-is. Gives an immediate audio +
  // visual cue on success (see playScanBeep/flashLineIndex) since staff
  // aren't necessarily watching the screen while scanning, and a brief,
  // non-blocking inline message on failure rather than a modal that would
  // stop them working.
  const handleScan = async (code: string) => {
    const weigh = parseWeighBarcode(code);
    const lookupCode = weigh ? weigh.itemCode : code;
    try {
      const product = weigh ? await api.products.getByItemCode(lookupCode) : await api.products.getByBarcode(lookupCode);
      scanFlashPending.current = true;
      addToCart(product, weigh?.price);
      playScanBeep();
      setSearch("");
    } catch {
      setScanError(`No product found for "${code}"`);
      window.setTimeout(() => setScanError(""), 3000);
    }
  };

  const updateLine = (index: number, patch: Partial<OrderItemInput>) =>
    setCart((cur) => cur.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, ...patch };
      return { ...next, lineTotal: calculateLineTotal(next) };
    }));

  const removeLine = (index: number) => {
    setCart((cur) => cur.filter((_, i) => i !== index));
    setSelectedLine((cur) => (cur == null ? null : cur === index ? null : cur > index ? cur - 1 : cur));
  };

  const selectLine = (index: number) => {
    setSelectedLine(index);
    const line = cart[index];
    setKeypadValue(line ? String(line.kg ?? line.quantity ?? "") : "");
  };

  const clearSale = () => { setCart([]); setDiscount(0); setBuyerName(""); setBuyerAddress(""); setPaymentMethod(null); setCashTendered(""); setCustomerNumber(""); setCustomerEmail(""); setError(""); setSelectedLine(null); setKeypadValue(""); setExpandedCategory(null); };

  // South African retail prices are required to be displayed VAT-inclusive
  // (Consumer Protection Act / VAT Act) — pricePerUnit is already the
  // sticker price, so "VAT" here is the tax component already sitting
  // inside the total, not an amount added on top. No tax-rate setting
  // exists yet anywhere in Settings, so 15% (the SA standard rate) is
  // hardcoded rather than configurable.
  const VAT_RATE = 0.15;
  const subtotal = cart.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);
  const clampedDiscount = Math.min(Math.max(0, discount), subtotal);
  const total = subtotal - clampedDiscount;
  const vat = total * (VAT_RATE / (1 + VAT_RATE));

  // Numeric keypad, below the slip preview — the manual weight/quantity
  // entry point for whichever line is selected (see selectLine), instead
  // of inline +/- steppers cluttering the receipt-styled slip itself.
  const selectedLineItem = selectedLine != null ? cart[selectedLine] : undefined;
  const keypadDigit = (d: string) => setKeypadValue((cur) => (cur === "0" ? d : cur + d));
  const keypadDecimal = () => setKeypadValue((cur) => (cur.includes(".") ? cur : cur ? cur + "." : "0."));
  const keypadBackspace = () => setKeypadValue((cur) => cur.slice(0, -1));
  const keypadClear = () => setKeypadValue("");
  const applyKeypad = () => {
    if (selectedLine == null || !selectedLineItem) return;
    const n = Number(keypadValue);
    if (!Number.isFinite(n) || n <= 0) return;
    if (selectedLineItem.quantity != null) updateLine(selectedLine, { quantity: Math.round(n) });
    else updateLine(selectedLine, { kg: Number(n.toFixed(3)) });
  };

  // SARS requires a full tax invoice (buyer name + address, not just a
  // till slip) for any single sale over R5,000 — see the SARS Tax Invoice
  // Guide. Below that, an abridged till slip is fine and no buyer details
  // are needed.
  const FULL_INVOICE_THRESHOLD = 5000;
  const needsFullInvoice = total > FULL_INVOICE_THRESHOLD;
  const tenderedAmount = Number(cashTendered) || 0;
  const changeDue = paymentMethod === "cash" ? tenderedAmount - total : 0;
  const canCheckout = cart.length > 0 && !submitting
    && (!needsFullInvoice || (buyerName.trim() && buyerAddress.trim()))
    && paymentMethod != null
    && (paymentMethod !== "cash" || tenderedAmount >= total);

  const checkout = async () => {
    if (!canCheckout) return;
    setSubmitting(true); setError("");
    const payload: CreateOrderInput = {
      // Deliberately empty for an ordinary sale — an empty customerName
      // tells buildReceiptHtml to skip the whole "Customer Details" block
      // rather than print a placeholder name. Only populated above the
      // R5,000 full-tax-invoice threshold, where SARS requires it.
      customerName: needsFullInvoice ? buyerName.trim() : "",
      customerPhone: "",
      orderType: "pickup",
      deliveryAddress: needsFullInvoice ? { street: buyerAddress.trim(), area: "", buildingType: "", apartment: "" } : { street: "", area: "", buildingType: "", apartment: "" },
      requestedTime: "",
      assignedTo: "",
      items: cart,
      completeImmediately: true,
      discountAmount: clampedDiscount,
      paymentMethod: paymentMethod ?? "cash",
      cashTendered: paymentMethod === "cash" ? tenderedAmount : null,
      customerNumber: customerNumber.trim() || null,
      customerEmail: customerEmail.trim() || null
    };
    try {
      const order = await api.orders.create(payload);
      clearSale();
      onCompleted(order);
      // Always the narrow thermal receipt layout here, regardless of the
      // admin's general KOT ticket print-style setting — a POS walk-in
      // sale is a till slip, not a full-page order form, so it shouldn't
      // print as an A4 "PDF"-looking document even if that's configured
      // for kitchen/counter tickets elsewhere.
      void printReceipt(order, "master", "thermal", printerMap.master ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete sale");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pos-panel">
      <div className="pos-catalog">
        <div className="pos-scan-panel">
          <label htmlFor="pos-scan-search" className="pos-scan-label">Scan or search a product</label>
          <div className="pos-search-row">
            <input
              id="pos-scan-search"
              className="pos-search"
              placeholder="Scan a barcode, or type a name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && search.trim()) void handleScan(search.trim()); }}
              autoFocus
            />
            <button type="button" className="secondary" onClick={() => { setReorderError(""); setReorderScanOpen(true); }} title="Scan a past receipt to add its items to this sale">
              <ScanLine size={16} /> Reorder
            </button>
          </div>
          {searchMatches.length > 0 && (
            <div className="pos-search-matches">
              {searchMatches.map((p) => (
                <button type="button" key={p.id} className="pos-search-match" onClick={() => { addToCart(p); setSearch(""); }}>
                  <span>{p.name}</span>
                  <span className="muted">{p.pricePerUnit != null ? `${currency.format(p.pricePerUnit)}${p.unitDefault === "qty" ? " ea" : "/kg"}` : "—"}</span>
                </button>
              ))}
            </div>
          )}
          {scanError && <p className="form-error">{scanError}</p>}
        </div>

        {reorderScanOpen && (
          <ScanCodeModal
            key={reorderScanAttempt}
            title="Reorder from receipt"
            hint="Point the camera at the barcode on a past receipt."
            busy={reorderBusy}
            error={reorderError}
            onDetected={(code) => void reorderFromTicket(code)}
            onClose={() => setReorderScanOpen(false)}
          />
        )}

        {quickPicks.length > 0 && (
          <div className="pos-quickpicks">
            <div className="pos-section-label">Quick picks</div>
            <div className="pos-quickpicks-row">
              {quickPicks.map((p) => (
                <button
                  key={p.id} type="button"
                  className={`pos-product-tile ${p.currentCost == null ? "pos-product-tile-nocost" : ""}`}
                  onClick={() => addToCart(p)}
                  title={p.currentCost == null ? "No cost price set — can't be sold yet" : undefined}
                >
                  <span className={`pos-product-badge ${categoryBadgeClass(p.category || "Other")}`}>{initials(p.name)}</span>
                  <span className="pos-product-name">{p.name}</span>
                  <span className="pos-product-price">{p.pricePerUnit != null ? `${currency.format(p.pricePerUnit)}${p.unitDefault === "qty" ? " ea" : "/kg"}` : "—"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pos-section-label">Categories</div>
        <div className="pos-category-tabs">
          {categories.map((c) => (
            <button
              key={c} type="button"
              className={`pos-category-tab ${expandedCategory === c ? "active" : ""}`}
              onClick={() => setExpandedCategory((cur) => (cur === c ? null : c))}
            >
              {c}
            </button>
          ))}
        </div>

        {expandedCategory && (
          <div className="pos-product-grid">
            {categoryProducts.map((p) => (
              <button
                key={p.id} type="button"
                className={`pos-product-tile ${p.currentCost == null ? "pos-product-tile-nocost" : ""}`}
                onClick={() => addToCart(p)}
                title={p.currentCost == null ? "No cost price set — can't be sold yet" : undefined}
              >
                <span className={`pos-product-badge ${categoryBadgeClass(p.category || "Other")}`}>{initials(p.name)}</span>
                <span className="pos-product-name">{p.name}</span>
                <span className="pos-product-price">{p.pricePerUnit != null ? `${currency.format(p.pricePerUnit)}${p.unitDefault === "qty" ? " ea" : "/kg"}` : "—"}</span>
                {p.currentCost == null && <span className="pos-product-nocost-flag">No cost price</span>}
              </button>
            ))}
            {categoryProducts.length === 0 && <p className="report-empty">No items in this category.</p>}
          </div>
        )}
      </div>

      <div className="pos-receipt">
        <div className="till-slip">
          <div className="till-slip-header">
            <div className="till-slip-business">{receiptBranding.siteName || "NemenchPos"}</div>
            <div className="till-slip-meta">{new Date().toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" })}</div>
          </div>
          <div className="till-slip-divider" />
          {cart.length === 0 ? (
            <p className="till-slip-empty">Scan or tap an item to start the sale.</p>
          ) : (
            <div className="till-slip-lines">
              {cart.map((line, i) => (
                <button type="button" key={i} className={`till-slip-line ${selectedLine === i ? "selected" : ""} ${flashLineIndex === i ? "flash" : ""}`} onClick={() => selectLine(i)}>
                  <div className="till-slip-line-top">
                    <span className="till-slip-line-name">{line.name}</span>
                    <span className="till-slip-line-total">{line.lineTotal != null ? currency.format(line.lineTotal) : "—"}</span>
                  </div>
                  {line.kg != null && (
                    <div className="till-slip-line-detail">{line.kg.toFixed(3)} kg @ {currency.format(line.unitPrice ?? 0)}/kg</div>
                  )}
                  {line.quantity != null && (
                    <div className="till-slip-line-detail">{line.quantity} x {currency.format(line.unitPrice ?? 0)}</div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="till-slip-divider" />
          <div className="till-slip-row">
            <span>Subtotal</span>
            <span>{currency.format(subtotal)}</span>
          </div>
          <div className="till-slip-row">
            <span>Discount</span>
            {clampedDiscount > 0 ? (
              <span>-{currency.format(clampedDiscount)} <button type="button" className="pos-discount-edit" onClick={() => setDiscountModalOpen(true)}>Edit</button></span>
            ) : (
              <button type="button" className="pos-discount-add" onClick={() => setDiscountModalOpen(true)}>+ Add discount</button>
            )}
          </div>
          {receiptBranding.vatRegistered && (
            <div className="till-slip-row">
              <span>VAT incl. (15%)</span>
              <span>{currency.format(vat)}</span>
            </div>
          )}
          <div className="till-slip-divider" />
          <div className="till-slip-row till-slip-total">
            <span>TOTAL</span>
            <span>{currency.format(total)}</span>
          </div>
        </div>

        <PosKeypad
          value={keypadValue}
          disabled={selectedLine == null}
          unitLabel={selectedLineItem?.quantity != null ? "units" : "kg"}
          onDigit={keypadDigit}
          onDecimal={keypadDecimal}
          onBackspace={keypadBackspace}
          onClear={keypadClear}
          onApply={applyKeypad}
          onRemove={() => { if (selectedLine != null) setPendingRemoveIndex(selectedLine); }}
        />

        {needsFullInvoice && (
          <div className="pos-invoice-fields">
            <p className="settings-hint">Sales over {currency.format(FULL_INVOICE_THRESHOLD)} legally require a full tax invoice — enter the buyer's details to continue.</p>
            <label>Buyer name<input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Required for sales over R5,000" /></label>
            <label>Buyer address<input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} placeholder="Required for sales over R5,000" /></label>
          </div>
        )}

        <div className="pos-customer-number">
          <label>Customer number <span className="settings-hint">(optional — for order-ready WhatsApp updates)</span>
            <input type="tel" value={customerNumber} onChange={(e) => setCustomerNumber(e.target.value)} placeholder="e.g. 082 123 4567" />
          </label>
          {/* Soft warning only — never blocks checkout (see canCheckout below),
              since a garbled number just means no WhatsApp update ever goes
              out, not a failed sale. Loose digit-count check, not a strict
              phone format, since this field accepts any country's numbers. */}
          {customerNumber.trim() && customerNumber.replace(/\D/g, "").length < 7 && (
            <p className="settings-hint pos-customer-number-warning">That doesn't look like a full phone number — WhatsApp updates won't reach it as typed.</p>
          )}
        </div>

        <div className="pos-customer-number">
          <label>Customer email <span className="settings-hint">(optional — for order-ready email updates)</span>
            <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="e.g. name@example.com" />
          </label>
          {customerEmail.trim() && !/\S+@\S+\.\S+/.test(customerEmail.trim()) && (
            <p className="settings-hint pos-customer-number-warning">That doesn't look like a full email address — updates won't reach it as typed.</p>
          )}
        </div>

        <div className="pos-payment-section">
          <div className="pos-payment-tabs">
            <button type="button" className={`pos-payment-tab ${paymentMethod === "cash" ? "active" : ""}`} onClick={() => setPaymentMethod("cash")}>Cash</button>
            <button type="button" className={`pos-payment-tab ${paymentMethod === "card" ? "active" : ""}`} onClick={() => { setPaymentMethod("card"); setCashTendered(""); }}>Card</button>
          </div>
          {paymentMethod === "cash" && (
            <div className="pos-cash-fields">
              <label>Amount tendered
                <input type="number" min="0" step="0.01" autoFocus value={cashTendered} onChange={(e) => setCashTendered(e.target.value)} placeholder={currency.format(total)} />
              </label>
              <div className={`pos-change-due ${changeDue < 0 ? "short" : ""}`}>
                <span>{changeDue < 0 ? "Still owing" : "Change due"}</span>
                <span>{currency.format(Math.abs(changeDue))}</span>
              </div>
            </div>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}
        <div className="pos-receipt-actions">
          <button type="button" className="pos-clear-btn" disabled={cart.length === 0 || submitting} onClick={() => setPendingClearSale(true)}>Clear Sale</button>
          <button type="button" className="pos-charge-btn" disabled={!canCheckout} onClick={() => void checkout()}>
            {submitting ? "Completing…" : `Pay now · ${currency.format(total)}`}
          </button>
        </div>
      </div>
      {pendingRemoveIndex != null && (
        <PinConfirmModal
          title="Remove item?"
          message={`Enter your PIN to remove "${cart[pendingRemoveIndex]?.name}" from this sale.`}
          onConfirm={() => { removeLine(pendingRemoveIndex); setPendingRemoveIndex(null); }}
          onCancel={() => setPendingRemoveIndex(null)}
        />
      )}
      {pendingClearSale && (
        <PinConfirmModal
          title="Clear sale?"
          message="Enter your PIN to clear this entire sale."
          onConfirm={() => { clearSale(); setPendingClearSale(false); }}
          onCancel={() => setPendingClearSale(false)}
        />
      )}
      {discountModalOpen && (
        <DiscountModal
          initialValue={discount}
          max={subtotal}
          onApply={(value) => { setDiscount(value); setDiscountModalOpen(false); }}
          onClose={() => setDiscountModalOpen(false)}
        />
      )}
    </div>
  );
}

// Manual weight/quantity entry for whichever till slip line is currently
// selected (see POSPanel's selectLine) — deliberately separate from the
// slip itself so the slip can stay a clean, receipt-styled read display
// rather than having +/- steppers baked into every line.
function PosKeypad({ value, disabled, unitLabel, onDigit, onDecimal, onBackspace, onClear, onApply, onRemove }: {
  value: string;
  disabled: boolean;
  unitLabel: "kg" | "units";
  onDigit: (d: string) => void;
  onDecimal: () => void;
  onBackspace: () => void;
  onClear: () => void;
  onApply: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`pos-keypad ${disabled ? "pos-keypad-disabled" : ""}`}>
      <div className="pos-keypad-display">
        <span>{value || "0"}</span>
        <span className="muted">{unitLabel}</span>
      </div>
      <div className="pos-keypad-grid">
        {["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"].map((k) => (
          <button
            key={k} type="button" disabled={disabled}
            onClick={() => { if (k === "⌫") onBackspace(); else if (k === ".") onDecimal(); else onDigit(k); }}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="pos-keypad-actions">
        <button type="button" className="secondary" disabled={disabled} onClick={onClear}>Clear</button>
        <button type="button" className="danger" disabled={disabled} onClick={onRemove}>Remove item</button>
        <button type="button" disabled={disabled || !value} onClick={onApply}>Update</button>
      </div>
    </div>
  );
}

// A flat rand-amount discount, entered as its own deliberate step rather
// than a bare number field sitting in the breakdown — same reasoning as
// Clear Sale needing to be a real button, not just easy to miss.
function DiscountModal({ initialValue, max, onApply, onClose }: { initialValue: number; max: number; onApply: (value: number) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"rand" | "percent">("rand");
  const [value, setValue] = useState(initialValue ? String(initialValue) : "");

  // Always resolves to (and persists as) a flat rand amount — % is just a
  // convenient way to enter one, computed off the current subtotal at the
  // moment it's applied. Switching mode re-derives the other unit from the
  // current input so a half-typed value isn't silently lost.
  const switchMode = (next: "rand" | "percent") => {
    const n = Number(value) || 0;
    if (mode === "rand" && next === "percent") setValue(max > 0 ? String(Number(((n / max) * 100).toFixed(2))) : "");
    if (mode === "percent" && next === "rand") setValue(String(Number(((n / 100) * max).toFixed(2))));
    setMode(next);
  };

  const resolvedRand = mode === "percent" ? (Math.min(Math.max(0, Number(value) || 0), 100) / 100) * max : Number(value) || 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(Math.min(Math.max(0, resolvedRand), max));
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>Discount</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <div className="order-type-toggle">
            <button type="button" className={mode === "rand" ? "active" : "secondary"} onClick={() => switchMode("rand")}>Rand (R)</button>
            <button type="button" className={mode === "percent" ? "active" : "secondary"} onClick={() => switchMode("percent")}>Percent (%)</button>
          </div>
          <label>{mode === "rand" ? "Discount amount (R)" : "Discount (%)"}
            <input
              type="number" min="0" step="0.01" max={mode === "rand" ? max : 100} autoFocus
              value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === "rand" ? "0.00" : "0"}
            />
          </label>
          {mode === "percent" && <p className="settings-hint">= {currency.format(resolvedRand)}</p>}
          <footer className="actions">
            {initialValue > 0 && <button type="button" className="danger" onClick={() => onApply(0)}>Remove discount</button>}
            <button type="submit">Apply</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// Generic "re-enter your PIN before this mistake-prone action" gate — checks
// the currently logged-in user's own PIN against the server (see
// /auth/verify-pin) without changing the session, then calls onConfirm.
// Doesn't re-check role/permissions itself; it's a fat-finger guard, not an
// authorization boundary — the underlying action still enforces its own.
function PinConfirmModal({ title, message, confirmLabel = "Confirm removal", onConfirm, onCancel }: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true); setError("");
    try {
      await api.auth.verifyPin(pin);
      onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect PIN");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="modal-body" onSubmit={(e) => void submit(e)}>
          <p>{message}</p>
          <label>PIN
            <input
              type="password" inputMode="numeric" autoFocus maxLength={8}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="actions">
            <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="danger" disabled={!pin || busy}>{busy ? "Checking…" : confirmLabel}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ── Barcode add modal ────────────────────────────────────────────────────────
// Camera-based barcode scanning (native camera UI on Android, the browser's
// BarcodeDetector API elsewhere — see useBarcodeScan) plus a manual-entry
// fallback for when the camera isn't available or permission is denied.
type BarcodeStep = "choice" | "scan" | "manual" | "create";

function BarcodeAddModal({ defaultDept, onAdd, onClose }: { defaultDept: Department; onAdd: (p: Product, wantedPrice?: number) => void; onClose: () => void }) {
  const [step, setStep] = useState<BarcodeStep>("choice");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [pendingBarcode, setPendingBarcode] = useState("");
  // Set when the scanned code decoded as a scale weigh-barcode but its PLU
  // isn't registered to any product yet — carried through to quick-create
  // so the brand-new product's first line still gets the price that was
  // actually on the label, not a blank one.
  const [pendingWeighPrice, setPendingWeighPrice] = useState<number | undefined>(undefined);
  const [createName, setCreateName] = useState("");
  const [createPrice, setCreatePrice] = useState("");
  const [createDept, setCreateDept] = useState<Department>(defaultDept);

  // Looks up a resolved barcode (from either scan or manual entry); on a
  // 404 it's treated as "not found yet" and routes to quick-create rather
  // than a dead-end error, per how this feature is meant to work.
  const resolveBarcode = async (code: string) => {
    setBusy(true); setError("");
    // A scale weigh-barcode embeds the price per-label, so it will never
    // exact-match a catalog barcode twice — look the product up by its
    // 5-digit item code instead of the full scanned code (a weighed
    // product's identity, never a plain `barcode` lookup — see
    // getProductByItemCode), and carry the decoded price along to
    // prefill as this line's "wanted price."
    const weigh = parseWeighBarcode(code);
    const lookupCode = weigh ? weigh.itemCode : code;
    try {
      const product = weigh ? await api.products.getByItemCode(lookupCode) : await api.products.getByBarcode(lookupCode);
      onAdd(product, weigh?.price);
    } catch {
      setPendingBarcode(lookupCode);
      setPendingWeighPrice(weigh?.price);
      setCreateName(""); setCreatePrice(""); setCreateDept(defaultDept);
      setStep("create");
    } finally {
      setBusy(false);
    }
  };

  const { videoRef, isNative } = useBarcodeScan({
    active: step === "scan",
    onDetected: (code) => void resolveBarcode(code),
    onError: (message) => { setError(message); setStep("choice"); }
  });

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
      // pendingWeighPrice is only ever set when the original scan decoded
      // as a weigh-barcode (see resolveBarcode) — same signal used there
      // to pick the lookup, reused here to pick which field pendingBarcode
      // actually is.
      const product = await api.products.quickCreate({
        name: createName.trim(),
        barcode: pendingWeighPrice == null ? pendingBarcode : undefined,
        itemCode: pendingWeighPrice != null ? pendingBarcode : undefined,
        pricePerUnit: createPrice ? Number(createPrice) : null,
        department: createDept
      });
      onAdd(product, pendingWeighPrice);
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
            {isNative
              ? <p className="settings-hint">Opening the camera…</p>
              : <><video ref={videoRef} className="barcode-video" muted playsInline /><p className="settings-hint">Point the camera at the barcode.</p></>}
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
            <p className="settings-hint">
              {pendingWeighPrice != null
                ? <>Recognized as a scale weigh-label (item code <b>{pendingBarcode}</b>, this label priced at {currency.format(pendingWeighPrice)}) but not registered yet — add it now.</>
                : <>No item found for barcode <b>{pendingBarcode}</b> — add it now.</>}
            </p>
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

// Generic "scan (or type) a code, hand the raw string back to the caller"
// modal — the shared building block behind Queue/History's "Scan order"
// button and POS's "Scan to reorder," both of which just need the decoded
// ticketNumber string handed back, not the barcode-to-product resolution
// BarcodeAddModal does (this is scanning an ORDER's barcode, never a
// product's). `busy`/`error` are controlled by the caller so it can show
// its own "looking up that order…" state after a code comes back, rather
// than this modal owning a lookup it doesn't know how to do.
function ScanCodeModal({ title, hint, busy, error, onDetected, onClose }: {
  title: string; hint: string; busy?: boolean; error?: string; onDetected: (code: string) => void; onClose: () => void;
}) {
  const [step, setStep] = useState<"scan" | "manual">("scan");
  const [manualCode, setManualCode] = useState("");

  const { videoRef, isNative } = useBarcodeScan({
    active: step === "scan",
    onDetected,
    onError: () => setStep("manual")
  });

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    onDetected(manualCode.trim());
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {step === "scan" && (
          <div className="modal-body barcode-scan">
            {isNative
              ? <p className="settings-hint">Opening the camera…</p>
              : <><video ref={videoRef} className="barcode-video" muted playsInline /><p className="settings-hint">{hint}</p></>}
            <button type="button" className="secondary" onClick={() => setStep("manual")}>Enter manually instead</button>
          </div>
        )}
        {step === "manual" && (
          <form className="modal-body" onSubmit={submitManual}>
            <label>Ticket number<input autoFocus value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="e.g. 20260712-002" /></label>
            <footer className="actions">
              <button type="button" className="secondary" onClick={() => setStep("scan")}>Back to camera</button>
              <button type="submit" disabled={busy || !manualCode.trim()}>{busy ? "Looking up…" : "Find"}</button>
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
  const [scanOpen, setScanOpen] = useState(false);
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
      <div className="search-bar-row">
        <div className="search-bar">
          <input placeholder="Search by name, phone, ticket or item…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
        </div>
        <button type="button" className="secondary" onClick={() => setScanOpen(true)} title="Scan a receipt's barcode"><ScanLine size={16} /> Scan order</button>
      </div>
      {displayed.length === 0
        ? <EmptyState title="No active tickets" detail="New orders will appear here." />
        : <div className="ticket-grid">{displayed.map((order) => <TicketCard key={order.id} order={order} currentUser={currentUser} onChanged={onChanged} printStyle={printStyle} printerMap={printerMap} />)}</div>
      }
      {scanOpen && (
        <ScanCodeModal
          title="Scan order"
          hint="Point the camera at the barcode on a printed receipt/ticket."
          onDetected={(code) => { setSearch(code); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}
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
  const canAddItems = currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier";
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [emailReceiptOpen, setEmailReceiptOpen] = useState(false);

  const addScannedItem = async (p: Product, wantedPrice?: number) => {
    setBarcodeModalOpen(false);
    const estimatedKg = wantedPrice && p.pricePerUnit ? Number((wantedPrice / p.pricePerUnit).toFixed(3)) : null;
    const item: OrderItemInput = { productId: p.id, name: p.name, kg: estimatedKg, quantity: null, notes: p.prepNotes, unitPrice: p.pricePerUnit, lineTotal: null, wantedPrice: wantedPrice ?? null, department: p.department };
    await api.orders.addItem(order.id, { ...item, lineTotal: calculateLineTotal(item) });
    await onChanged();
  };

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
              {item.kg ? `${item.kg} kg` : item.wantedPrice ? `${currency.format(item.wantedPrice)} (to weigh)` : ""}
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
          {canAddItems && <button className="secondary sm" onClick={() => setEmailReceiptOpen(true)} title="Email receipt"><Mail size={16} /> Email</button>}
          {canAddItems && order.status !== "Done" && (
            <button className="secondary sm" onClick={() => setBarcodeModalOpen(true)}><ScanLine size={16} /> Scan</button>
          )}
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
      {barcodeModalOpen && (
        <BarcodeAddModal defaultDept={currentUser.department ?? "counter"} onAdd={(p, wantedPrice) => void addScannedItem(p, wantedPrice)} onClose={() => setBarcodeModalOpen(false)} />
      )}
      {emailReceiptOpen && (
        <EmailReceiptModal order={order} printStyle={printStyle} onClose={() => setEmailReceiptOpen(false)} />
      )}
    </article>
  );
}

// ── History ───────────────────────────────────────────────────────────────────

// Table of completed ("Done") orders within the configured retention window.
function HistoryView({ orders, printStyle, printerMap }: { orders: Order[]; printStyle: string; printerMap: Record<string, string> }) {
  const [search, setSearch] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [emailReceiptOrder, setEmailReceiptOrder] = useState<Order | null>(null);
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
      <div className="search-bar-row">
        <div className="search-bar">
          <input placeholder="Search by name, phone, ticket, item or staff…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
        </div>
        <button type="button" className="secondary" onClick={() => setScanOpen(true)} title="Scan a receipt's barcode"><ScanLine size={16} /> Scan order</button>
      </div>
      {scanOpen && (
        <ScanCodeModal
          title="Scan order"
          hint="Point the camera at the barcode on a printed receipt/ticket."
          onDetected={(code) => { setSearch(code); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}
      <table>
          <thead>
            <tr><th>Ticket</th><th>Customer</th><th>Phone</th><th>Requested by</th><th>Items</th><th>Completed</th><th></th></tr>
          </thead>
          <tbody>
            {displayed.map((order) => (
              <tr key={order.id}>
                <td>{order.ticketNumber}</td>
                <td>{order.customerName || "POS sale"}</td>
                <td>{order.customerPhone}</td>
                <td>{order.requestedByName ?? "—"}</td>
                <td>{order.items.length}</td>
                <td>{new Date(order.updatedAt).toLocaleString(appSettings.locale)}</td>
                <td>
                  <button className="secondary sm" onClick={() => void printReceipt(order, "master", printStyle, printerMap.master ?? "")} title="Print master receipt"><Printer size={16} /> Print</button>
                  <button className="secondary sm" onClick={() => setEmailReceiptOrder(order)} title="Email receipt"><Mail size={16} /> Email</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      {emailReceiptOrder && (
        <EmailReceiptModal order={emailReceiptOrder} printStyle={printStyle} onClose={() => setEmailReceiptOrder(null)} />
      )}
    </div>
  );
}

// ── Order Consolidation ──────────────────────────────────────────────────────

// Final packing/QA step: staff pick a "Ready" (prepared, not yet handed
// over) order, scan every line item's barcode to verify it against that
// order, then finalize into one consolidation barcode + receipt. See
// server/database.ts's Order Consolidation section for the actual
// scan-matching/finalize rules this UI is just a thin front-end for.
function ConsolidationPanel({ printStyle, printerMap }: { printStyle: string; printerMap: Record<string, string> }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Order | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  // Bumped on a failed scan so <ScanCodeModal key={scanAttempt}> fully
  // remounts (and its camera restarts) — same reasoning as POS's
  // reorderScanAttempt.
  const [scanAttempt, setScanAttempt] = useState(0);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [finalized, setFinalized] = useState<Order | null>(null);

  const load = () => {
    setLoading(true);
    api.consolidation.pending().then(setOrders).catch(() => undefined).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  const selectOrder = (order: Order) => {
    setSelected(order);
    setFinalized(null);
    setFinalizeError("");
    setScanError("");
  };

  const scanCode = async (code: string) => {
    if (!selected) return;
    setScanBusy(true); setScanError("");
    try {
      const updated = await api.consolidation.scan(selected.id, code);
      setSelected(updated);
      setScanOpen(false);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
      setScanAttempt((n) => n + 1);
    } finally {
      setScanBusy(false);
    }
  };

  const finalize = async () => {
    if (!selected) return;
    setFinalizing(true); setFinalizeError("");
    try {
      const result = await api.consolidation.finalize(selected.id);
      setFinalized(result);
      setSelected(null);
      load();
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : "Could not finalize");
    } finally {
      setFinalizing(false);
    }
  };

  // Free-text lines (no productId) have no barcode to scan, so they're
  // excluded from what "every item scanned" requires — same rule the
  // server enforces in finalizeConsolidation, kept in sync here so the
  // Finalize button's enabled state actually matches what a click would do.
  const scannable = selected ? selected.items.filter((i) => i.productId != null) : [];
  const scannedCount = scannable.filter((i) => i.scannedAt).length;
  const allScanned = scannable.every((i) => i.scannedAt);

  if (finalized) {
    return (
      <div className="panel consolidation-result">
        <h2>Order consolidated</h2>
        <p className="settings-hint">Ticket {finalized.ticketNumber} — every item verified. One barcode now represents the whole order.</p>
        {finalized.consolidationBarcode && <BarcodeImage value={finalized.consolidationBarcode} />}
        <footer className="actions">
          <button type="button" onClick={() => void printReceipt(finalized, "master", printStyle, printerMap.master ?? "")}><Printer size={16} /> Print receipt</button>
          <button type="button" className="secondary" onClick={() => setFinalized(null)}>Done</button>
        </footer>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="panel">
        <div className="modal-header">
          <h2>{selected.ticketNumber} — {selected.customerName || "POS sale"}</h2>
          <button type="button" className="secondary" onClick={() => setSelected(null)}>Back to list</button>
        </div>
        <p className="settings-hint">{scannedCount} of {scannable.length} items scanned</p>
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th></th></tr></thead>
          <tbody>
            {selected.items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}{i.notes ? <div className="note">{i.notes}</div> : null}</td>
                <td>{i.kg ? `${i.kg} kg` : i.quantity ? `×${i.quantity}` : "—"}</td>
                <td>
                  {i.productId == null
                    ? <span className="muted">No barcode</span>
                    : i.scannedAt
                      ? <span className="consent-badge consent-opted_in">Scanned</span>
                      : <span className="consent-badge consent-unknown">Pending</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!allScanned && <p className="form-error">{scannable.length - scannedCount} of {scannable.length} items still need to be scanned</p>}
        {finalizeError && <p className="form-error">{finalizeError}</p>}
        <footer className="actions">
          <button type="button" className="secondary" onClick={() => { setScanError(""); setScanOpen(true); }}><ScanLine size={16} /> Scan item</button>
          <button type="button" disabled={!allScanned || finalizing} onClick={() => void finalize()}>{finalizing ? "Finalizing…" : "Finalize order"}</button>
        </footer>
        {scanOpen && (
          <ScanCodeModal
            key={scanAttempt}
            title="Scan item"
            hint="Point the camera at the product's barcode."
            busy={scanBusy}
            error={scanError}
            onDetected={(code) => void scanCode(code)}
            onClose={() => setScanOpen(false)}
          />
        )}
      </div>
    );
  }

  if (!loading && orders.length === 0) {
    return <EmptyState title="Nothing to consolidate" detail="Orders show up here once they're Ready and haven't been consolidated yet." />;
  }

  return (
    <div className="panel table-panel">
      <table>
        <thead><tr><th>Ticket</th><th>Customer</th><th>Items</th><th>Ready since</th><th></th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          {!loading && orders.map((o) => (
            <tr key={o.id}>
              <td>{o.ticketNumber}</td>
              <td>{o.customerName || "POS sale"}</td>
              <td>{o.items.length}</td>
              <td>{new Date(o.updatedAt).toLocaleString(appSettings.locale)}</td>
              <td><button type="button" className="secondary sm" onClick={() => selectOrder(o)}>Consolidate</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Print Labels ──────────────────────────────────────────────────────────────

const LAST_LABEL_FORMAT_KEY = "nemenchpos-last-label-format";

// One row in the on-screen batch: a product plus how many copies and
// (for a weighed product) what weight to print it at. Kept separate from
// LabelBatchEntry (shared/labelBatch.ts) since the row needs raw form
// state (the weight as a string mid-edit) — batchEntries below derives
// the real LabelBatchEntry[] from this every render, so print/preview
// always read the CURRENT rows, never a stale snapshot taken at some
// earlier point (the exact class of bug a selection feature like this
// usually has: printing from a copy of the selection instead of the live one).
interface LabelBatchRow {
  id: string;
  product: Product;
  weightKgText: string;
  quantity: number;
}

// Raw, string-valued form state for adding/editing a custom sheet format
// not covered by the bundled Tower/Avery presets — kept as strings (not
// numbers) since fields are legitimately blank mid-edit, same reasoning
// as LabelBatchRow.weightKgText above. Parsed to LabelFormatInput only on
// submit (see toCustomFormatInput).
interface CustomFormatFormState {
  brand: string;
  code: string;
  type: "thermal" | "a4_sheet";
  widthMm: string;
  heightMm: string;
  sheetCols: string;
  sheetRows: string;
  marginTopMm: string;
  marginLeftMm: string;
  gapXMm: string;
  gapYMm: string;
  pageWidthMm: string;
  pageHeightMm: string;
}

const EMPTY_CUSTOM_FORMAT: CustomFormatFormState = {
  brand: "", code: "", type: "a4_sheet", widthMm: "", heightMm: "", sheetCols: "", sheetRows: "",
  marginTopMm: "", marginLeftMm: "", gapXMm: "", gapYMm: "", pageWidthMm: "", pageHeightMm: ""
};

function customFormatFromLabelFormat(f: LabelFormat): CustomFormatFormState {
  return {
    brand: f.brand ?? "",
    code: f.code ?? "",
    type: f.type,
    widthMm: String(f.widthMm),
    heightMm: String(f.heightMm),
    sheetCols: f.sheetCols != null ? String(f.sheetCols) : "",
    sheetRows: f.sheetRows != null ? String(f.sheetRows) : "",
    marginTopMm: f.marginTopMm != null ? String(f.marginTopMm) : "",
    marginLeftMm: f.marginLeftMm != null ? String(f.marginLeftMm) : "",
    gapXMm: f.gapXMm != null ? String(f.gapXMm) : "",
    gapYMm: f.gapYMm != null ? String(f.gapYMm) : "",
    pageWidthMm: f.pageWidthMm != null ? String(f.pageWidthMm) : "",
    pageHeightMm: f.pageHeightMm != null ? String(f.pageHeightMm) : ""
  };
}

// Blank margin/gap/page-size fields fall back to 0 (margins/gaps) or
// null (page size, meaning "default 210x297 A4 portrait" — see
// LabelFormat's schema comment) rather than being required — a first
// pass at a custom format is often "I know the label size and how many
// fit, I'll nudge the margins after a real test print" (same TODO/
// calibrate posture already used for the bundled presets' own less-
// certain entries).
function toCustomFormatInput(form: CustomFormatFormState): LabelFormatInput {
  const num = (s: string): number | null => (s.trim() ? Number(s) : null);
  return {
    brand: form.brand,
    code: form.code,
    type: form.type,
    widthMm: Number(form.widthMm),
    heightMm: Number(form.heightMm),
    sheetCols: form.type === "a4_sheet" ? num(form.sheetCols) : null,
    sheetRows: form.type === "a4_sheet" ? num(form.sheetRows) : null,
    marginTopMm: num(form.marginTopMm) ?? 0,
    marginLeftMm: num(form.marginLeftMm) ?? 0,
    gapXMm: num(form.gapXMm) ?? 0,
    gapYMm: num(form.gapYMm) ?? 0,
    pageWidthMm: num(form.pageWidthMm),
    pageHeightMm: num(form.pageHeightMm)
  };
}

// Search, add one or more products to a batch (each with its own
// quantity, and weight if sold by weight), pick a sheet/roll format, and
// print. Selection controls and the live preview are rendered by this
// SAME component into one panel (see the return statement below) — not
// a separate component instantiated alongside it — so there's no
// "captured selection" that could go stale: the preview reads the exact
// same batchEntries/format/blockedPositions state the print button does,
// on every render.
function PrintLabelsPanel({ products, printerName }: { products: Product[]; printerName: string }) {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<LabelBatchRow[]>([]);
  const [formats, setFormats] = useState<LabelFormat[]>([]);
  const [formatId, setFormatId] = useState("");
  const [formatQuery, setFormatQuery] = useState("");
  // The results list only takes over the panel while actively picking a
  // format — collapsed to a single summary line the rest of the time, so
  // it doesn't compete for space with the batch list below it (this was
  // previously always-expanded, which is what made the sidebar cramped
  // enough to force a horizontal scrollbar on long rows).
  const [formatPickerOpen, setFormatPickerOpen] = useState(false);
  const [blockedPositions, setBlockedPositions] = useState<Set<number>>(new Set());
  const [alignmentMode, setAlignmentMode] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState("");
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customFormEditingId, setCustomFormEditingId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState<CustomFormatFormState>(EMPTY_CUSTOM_FORMAT);
  const [customFormBusy, setCustomFormBusy] = useState(false);
  const [customFormError, setCustomFormError] = useState("");

  useEffect(() => { void loadFormats(); }, []);

  // Shared by the initial load and by create/edit/delete of a custom
  // format — always re-fetches from the server rather than patching
  // local state by hand, so the picker can never drift from what's
  // actually saved. `selectId`, if given, is preferred over the usual
  // remembered/admin-default priority (used right after creating/editing
  // a format, so it's immediately selected).
  const loadFormats = async (selectId?: string) => {
    const [list, settings] = await Promise.all([api.labels.formats(), api.settings.get().catch(() => ({} as Record<string, string>))]);
    setFormats(list);
    const remembered = localStorage.getItem(LAST_LABEL_FORMAT_KEY);
    const initial = (selectId && list.find((f) => f.id === selectId))
      ?? list.find((f) => f.id === remembered)
      ?? list.find((f) => f.id === settings.activeLabelSheetFormat)
      ?? list[0];
    if (initial) setFormatId(initial.id);
  };

  const matches = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.trim().toLowerCase();
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? "").includes(q) || (p.itemCode ?? "").includes(q)).slice(0, 20);
  }, [products, search]);

  const addProduct = (p: Product) => {
    setRows((cur) => [...cur, { id: `${p.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, product: p, weightKgText: "", quantity: 1 }]);
    setSearch("");
    setMessage("");
  };

  const updateRow = (id: string, patch: Partial<Pick<LabelBatchRow, "weightKgText" | "quantity">>) => {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    setRows((cur) => cur.filter((r) => r.id !== id));
  };

  const format = formats.find((f) => f.id === formatId) ?? null;

  // The single source of truth both the preview and the print button read
  // from — derived fresh from `rows` on every render, so there's no
  // separate "captured selection" that could go stale between selecting
  // products and clicking print.
  const batchEntries: LabelBatchEntry[] = useMemo(() => rows.map((r) => {
    const isWeighed = r.product.unitDefault !== "qty";
    const data: LabelData = {
      name: r.product.name,
      barcode: r.product.barcode ?? "",
      itemCode: r.product.itemCode,
      pricePerUnit: r.product.pricePerUnit,
      unitDefault: r.product.unitDefault,
      weightKg: isWeighed && r.weightKgText ? Number(r.weightKgText) : null
    };
    return { id: r.id, data, quantity: r.quantity };
  }), [rows]);

  const totalCount = totalBatchCount(batchEntries);

  const changeFormat = (id: string) => {
    setFormatId(id);
    setBlockedPositions(new Set());
    localStorage.setItem(LAST_LABEL_FORMAT_KEY, id);
    setFormatPickerOpen(false);
    setFormatQuery("");
  };

  const toggleBlockedPosition = (pos: number) => {
    setBlockedPositions((cur) => {
      const next = new Set(cur);
      if (next.has(pos)) next.delete(pos); else next.add(pos);
      return next;
    });
  };

  const openAddCustomFormat = () => {
    setCustomFormEditingId(null);
    setCustomForm(EMPTY_CUSTOM_FORMAT);
    setCustomFormError("");
    setCustomFormOpen(true);
  };

  const openEditCustomFormat = (f: LabelFormat) => {
    setCustomFormEditingId(f.id);
    setCustomForm(customFormatFromLabelFormat(f));
    setCustomFormError("");
    setCustomFormOpen(true);
  };

  const closeCustomFormatForm = () => {
    setCustomFormOpen(false);
    setCustomFormEditingId(null);
    setCustomFormError("");
  };

  const submitCustomFormat = async () => {
    const input = toCustomFormatInput(customForm);
    setCustomFormBusy(true); setCustomFormError("");
    try {
      const saved = customFormEditingId
        ? await api.labels.updateFormat(customFormEditingId, input)
        : await api.labels.createFormat(input);
      await loadFormats(saved.id);
      closeCustomFormatForm();
      setFormatPickerOpen(false);
      setFormatQuery("");
    } catch (err) {
      setCustomFormError(err instanceof Error ? err.message : "Could not save this format.");
    } finally {
      setCustomFormBusy(false);
    }
  };

  const deleteCustomFormat = async (f: LabelFormat) => {
    if (!window.confirm(`Delete the custom format "${f.name}"? This can't be undone.`)) return;
    await api.labels.deleteFormat(f.id);
    await loadFormats();
  };

  const print = async () => {
    if (!format || rows.length === 0) return;
    for (const r of rows) {
      const isWeighed = r.product.unitDefault !== "qty";
      if (isWeighed && !r.product.itemCode) { setMessage(`${r.product.name} has no item code yet — add one in Stock before printing.`); return; }
      if (isWeighed && !r.weightKgText) { setMessage(`Enter the weighed amount for ${r.product.name} first.`); return; }
      if (!isWeighed && !r.product.barcode) { setMessage(`${r.product.name} has no barcode yet — add one in Stock before printing.`); return; }
      if (r.quantity < 1) { setMessage(`${r.product.name} needs a quantity of at least 1.`); return; }
    }
    setPrinting(true); setMessage("");
    try {
      const flat = flattenBatch(batchEntries);
      const html = applyColorMode(format.type === "thermal"
        ? buildThermalPrintHtml(flat, format)
        : buildA4SheetHtml(flat, format, blockedPositions));
      // Same silent-print-then-fallback pattern as printReceipt/
      // printTestPage: send straight to the assigned label printer
      // unless "Force print preview" (Settings > Printing) is on, in
      // which case (or with no printer assigned) fall through to the
      // browser print dialog. This used to always go straight to
      // printHtml regardless of the printer assignment or the force-
      // preview setting — turning the setting off had no effect here
      // since this path never even checked it.
      if (printerName && !printPrefs.forcePreview) {
        try { await api.print(printerName, html); return; }
        catch (err) {
          showToast(`Couldn't print to "${printerName}" (${err instanceof Error ? err.message : "unknown error"}) — opening browser print instead.`, "error");
        }
      }
      printHtml(html);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not build the label print job.");
    } finally {
      setPrinting(false);
    }
  };

  const formatsByBrand = useMemo(() => {
    const groups = new Map<string, LabelFormat[]>();
    for (const f of formats) {
      const key = f.brand ?? "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    return groups;
  }, [formats]);

  // Fuzzy/partial live search over the whole format table — matches
  // brand, vendor code, name, and either dimension, so "102" finds W102,
  // "50" surfaces every ~50mm format (round or otherwise), and "tower"
  // narrows to just that brand. No submit step: filteredFormats just
  // recomputes on every keystroke. Browsing with an empty query falls
  // back to the full brand-grouped list (formatsByBrand) so the picker is
  // still useful before anyone's typed anything.
  const filteredFormats = useMemo(() => {
    const q = formatQuery.trim().toLowerCase();
    if (!q) return formats;
    return formats.filter((f) =>
      (f.brand ?? "").toLowerCase().includes(q) ||
      (f.code ?? "").toLowerCase().includes(q) ||
      f.name.toLowerCase().includes(q) ||
      String(f.widthMm).includes(q) ||
      String(f.heightMm).includes(q)
    );
  }, [formats, formatQuery]);

  const describeFormat = (f: LabelFormat): string => {
    const labelSize = `${f.widthMm} x ${f.heightMm}mm label`;
    if (f.type === "thermal") return `${labelSize} · thermal roll`;
    const pageSize = `${f.pageWidthMm ?? 210} x ${f.pageHeightMm ?? 297}mm sheet`;
    const perSheet = f.sheetCols && f.sheetRows ? `${f.sheetCols * f.sheetRows} per sheet` : "? per sheet";
    return `${pageSize} · ${labelSize} · ${perSheet}`;
  };

  // ── Live preview, derived from the exact same batchEntries/format/
  // blockedPositions state the controls above and the print() button
  // read from — this is what makes the preview and the print output
  // structurally unable to drift apart, not just visually similar.
  const flat = useMemo(() => flattenBatch(batchEntries), [batchEntries]);
  const pageWidthMm = format?.pageWidthMm ?? 210;
  const pageHeightMm = format?.pageHeightMm ?? 297;
  const singleHtml = useMemo(() => (format && flat.length > 0) ? buildThermalPrintHtml(flat.slice(0, 1), format) : "", [flat, format]);
  const perSheet = format?.type === "a4_sheet" && format.sheetCols && format.sheetRows ? format.sheetCols * format.sheetRows : 0;
  const sheetsNeeded = useMemo(() => perSheet > 0 ? placeOnSheets(flat, perSheet, blockedPositions).length : 0, [flat, perSheet, blockedPositions]);
  const sheetHtml = useMemo(() => {
    if (!format || format.type !== "a4_sheet" || perSheet === 0) return "";
    // Only render enough labels to fill page 1 — the preview only ever
    // shows that page, so there's no reason to build (and hide) HTML for
    // sheets 2..N of a large batch. Always the real, filled content —
    // "check alignment" is a grid-line overlay drawn on TOP of this (see
    // SheetPositionPicker below), never a swap to a blank sheet, so the
    // actual label content is never hidden by turning it on.
    const available1 = Math.max(0, perSheet - blockedPositions.size);
    return buildA4SheetHtml(flat.slice(0, available1), format, blockedPositions);
  }, [format, perSheet, flat, blockedPositions]);

  // Everything — search, the batch list, the sheet format picker, the
  // print trigger, AND the live grid preview — lives inside this single
  // panel, in one component's JSX tree. There is no separate "selection"
  // component rendered next to a "preview" component: the controls below
  // are literally nested inside .label-preview, the same persistent
  // surface the live grid renders into.
  return (
    <div className="panel label-preview label-print-panel">
      <div className="label-preview-header">
        <h2>{totalCount} label{totalCount === 1 ? "" : "s"} selected</h2>
        {format?.type === "a4_sheet" && perSheet > 0 && (
          <button type="button" className={alignmentMode ? "toggle-on" : "toggle-off"} onClick={() => setAlignmentMode((v) => !v)}>
            {alignmentMode ? "Hide alignment grid" : "Check alignment"}
          </button>
        )}
      </div>

      <div className="label-print-body">
        <div className="label-print-controls">
          <input placeholder="Search products by name, barcode or item code…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          {matches.length > 0 && (
            <div className="print-labels-matches">
              {matches.map((p) => (
                <button type="button" key={p.id} className="secondary" onClick={() => addProduct(p)}>
                  {p.name} {p.barcode ? <span className="muted">({p.barcode})</span> : p.itemCode ? <span className="muted">({p.itemCode})</span> : <span className="muted">(no code)</span>}
                </button>
              ))}
            </div>
          )}
          {search.trim() && matches.length === 0 && <p className="settings-hint">No products match.</p>}

          {rows.length > 0 && (
            <div className="label-batch-list">
              {rows.map((r) => {
                const isWeighed = r.product.unitDefault !== "qty";
                return (
                  <div className="label-batch-row" key={r.id}>
                    <div className="label-batch-row-top">
                      <div className="label-batch-row-info">
                        <strong title={r.product.name}>{r.product.name}</strong>
                        <span className="muted">
                          {r.product.pricePerUnit != null ? `${currency.format(r.product.pricePerUnit)}${isWeighed ? "/kg" : ""}` : "No price set"}
                          {" · "}
                          {isWeighed ? (r.product.itemCode || "No item code") : (r.product.barcode || "No barcode")}
                        </span>
                      </div>
                      <button type="button" className="icon-button danger sm" onClick={() => removeRow(r.id)} title="Remove from batch" aria-label="Remove from batch"><Trash2 size={16} /></button>
                    </div>
                    <div className="label-batch-row-bottom">
                      {isWeighed && (
                        <label className="label-batch-field">Weight (kg)
                          <input type="number" min="0" step="0.001" placeholder="0.000" value={r.weightKgText} onChange={(e) => updateRow(r.id, { weightKgText: e.target.value })} />
                        </label>
                      )}
                      <label className="label-batch-field">Qty
                        <input type="number" min="1" max="5000" value={r.quantity} onChange={(e) => updateRow(r.id, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="format-picker">
            <span className="format-picker-label">Label / sticker sheet format</span>
            {!formatPickerOpen ? (
              <div className="format-picker-collapsed">
                {format ? (
                  <div className="format-picker-selected">
                    <strong>{format.brand ? `${format.brand}${format.code ? ` ${format.code}` : ""}` : format.name}</strong>
                    <span className="muted">{describeFormat(format)}</span>
                  </div>
                ) : (
                  <span className="muted">Loading formats…</span>
                )}
                <button type="button" className="secondary sm" onClick={() => setFormatPickerOpen(true)}>Change</button>
              </div>
            ) : (
              <>
                <input
                  id="label-format-search"
                  placeholder="Search by brand, code or size (e.g. &quot;102&quot;, &quot;50&quot;, &quot;tower&quot;)…"
                  value={formatQuery}
                  onChange={(e) => setFormatQuery(e.target.value)}
                  autoFocus
                />
                <div className="format-picker-results">
                  {(formatQuery.trim() ? [["Results", filteredFormats] as [string, LabelFormat[]]] : [...formatsByBrand.entries()]).map(([brand, list]) => (
                    <div className="format-picker-group" key={brand}>
                      <div className="format-picker-group-label">{brand}</div>
                      {list.map((f) => (
                        <div className={`format-picker-row-wrap${f.id === formatId ? " active" : ""}`} key={f.id}>
                          <button type="button" className="format-picker-row" onClick={() => changeFormat(f.id)}>
                            <span className="format-picker-name">{f.brand ? `${f.brand} ${f.code ?? f.name}` : f.name}</span>
                            <span className="format-picker-meta">{describeFormat(f)}</span>
                          </button>
                          {f.id.startsWith("custom_") && (
                            <span className="format-picker-row-actions">
                              <button type="button" className="icon-button sm" title="Edit this custom format" aria-label="Edit" onClick={() => openEditCustomFormat(f)}><Pencil size={14} /></button>
                              <button type="button" className="icon-button danger sm" title="Delete this custom format" aria-label="Delete" onClick={() => void deleteCustomFormat(f)}><Trash2 size={14} /></button>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                  {formatQuery.trim() && filteredFormats.length === 0 && <p className="settings-hint">No formats match &quot;{formatQuery}&quot;.</p>}
                </div>
                <button type="button" className="secondary sm" onClick={() => { setFormatPickerOpen(false); setFormatQuery(""); }}>Done</button>
              </>
            )}

            {formatPickerOpen && (!customFormOpen ? (
              <button type="button" className="secondary sm" onClick={openAddCustomFormat}><Plus size={14} /> Add a sheet not listed above</button>
            ) : (
              <div className="custom-format-form">
                <h4>{customFormEditingId ? "Edit custom sheet" : "Add a custom sheet"}</h4>
                <p className="settings-hint">Have a brand/size not in the list above? Enter what's printed on the sheet's packaging — you can nudge the margins later once you've test-printed a page.</p>
                <div className="custom-format-grid">
                  <label>Brand<input value={customForm.brand} onChange={(e) => setCustomForm({ ...customForm, brand: e.target.value })} placeholder="e.g. Croxley" /></label>
                  <label>Product code<input value={customForm.code} onChange={(e) => setCustomForm({ ...customForm, code: e.target.value })} placeholder="e.g. CX4102" /></label>
                  <label>Type
                    <select value={customForm.type} onChange={(e) => setCustomForm({ ...customForm, type: e.target.value as "thermal" | "a4_sheet" })}>
                      <option value="a4_sheet">Sheet (multiple labels per page)</option>
                      <option value="thermal">Thermal roll (one label per print)</option>
                    </select>
                  </label>
                  <label>Label width (mm)<input type="number" min="0" step="0.1" value={customForm.widthMm} onChange={(e) => setCustomForm({ ...customForm, widthMm: e.target.value })} /></label>
                  <label>Label height (mm)<input type="number" min="0" step="0.1" value={customForm.heightMm} onChange={(e) => setCustomForm({ ...customForm, heightMm: e.target.value })} /></label>
                  {customForm.type === "a4_sheet" && (
                    <>
                      <label>Columns<input type="number" min="1" step="1" value={customForm.sheetCols} onChange={(e) => setCustomForm({ ...customForm, sheetCols: e.target.value })} /></label>
                      <label>Rows<input type="number" min="1" step="1" value={customForm.sheetRows} onChange={(e) => setCustomForm({ ...customForm, sheetRows: e.target.value })} /></label>
                      <label>Top margin (mm) <span className="optional-hint">(optional)</span><input type="number" step="0.1" value={customForm.marginTopMm} onChange={(e) => setCustomForm({ ...customForm, marginTopMm: e.target.value })} placeholder="0" /></label>
                      <label>Left margin (mm) <span className="optional-hint">(optional)</span><input type="number" step="0.1" value={customForm.marginLeftMm} onChange={(e) => setCustomForm({ ...customForm, marginLeftMm: e.target.value })} placeholder="0" /></label>
                      <label>Gap between columns (mm) <span className="optional-hint">(optional)</span><input type="number" step="0.1" value={customForm.gapXMm} onChange={(e) => setCustomForm({ ...customForm, gapXMm: e.target.value })} placeholder="0" /></label>
                      <label>Gap between rows (mm) <span className="optional-hint">(optional)</span><input type="number" step="0.1" value={customForm.gapYMm} onChange={(e) => setCustomForm({ ...customForm, gapYMm: e.target.value })} placeholder="0" /></label>
                      <label>Page width (mm) <span className="optional-hint">(optional — default 210, A4)</span><input type="number" step="0.1" value={customForm.pageWidthMm} onChange={(e) => setCustomForm({ ...customForm, pageWidthMm: e.target.value })} placeholder="210" /></label>
                      <label>Page height (mm) <span className="optional-hint">(optional — default 297, A4)</span><input type="number" step="0.1" value={customForm.pageHeightMm} onChange={(e) => setCustomForm({ ...customForm, pageHeightMm: e.target.value })} placeholder="297" /></label>
                    </>
                  )}
                </div>
                {customFormError && <p className="form-error">{customFormError}</p>}
                <footer className="actions">
                  <button type="button" className="secondary" onClick={closeCustomFormatForm}>Cancel</button>
                  <button type="button" disabled={customFormBusy || !customForm.brand.trim() || !customForm.code.trim() || !customForm.widthMm || !customForm.heightMm} onClick={() => void submitCustomFormat()}>
                    {customFormBusy ? "Saving…" : customFormEditingId ? "Save changes" : "Add format"}
                  </button>
                </footer>
              </div>
            ))}
          </div>

          {message && <p className="form-error">{message}</p>}

          <footer className="actions">
            <button type="button" disabled={printing || !format || rows.length === 0} onClick={() => void print()}>
              <Printer size={16} /> {printing ? "Printing…" : `Print ${totalCount} label${totalCount === 1 ? "" : "s"}`}
            </button>
          </footer>
        </div>

        {format && (
          <div className="label-print-preview">
            <div className="label-preview-single">
              <h3>Single label</h3>
              <div className="label-preview-frame" style={{ aspectRatio: `${format.widthMm} / ${format.heightMm}` }}>
                {singleHtml ? <iframe title="Label preview" srcDoc={singleHtml} /> : <div className="label-preview-empty">Add a product to preview</div>}
              </div>
            </div>

            {format.type === "a4_sheet" && format.sheetCols && format.sheetRows && (
              <div className="label-preview-sheet">
                <h3>Sheet layout (page 1 of {Math.max(1, sheetsNeeded)})</h3>
                <ScaledSheetFrame srcDoc={sheetHtml} pageWidthMm={pageWidthMm} pageHeightMm={pageHeightMm}>
                  <SheetPositionPicker cols={format.sheetCols} rows={format.sheetRows} format={format} blocked={blockedPositions} onToggle={toggleBlockedPosition} showGrid={alignmentMode} />
                </ScaledSheetFrame>
                <p className="settings-hint">
                  Click directly on a label above to mark it as already used on a partially-used sheet — the print job will skip it and fill the remaining gaps instead.
                  {blockedPositions.size > 0 && ` (${blockedPositions.size} marked used)`}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stock ─────────────────────────────────────────────────────────────────────

// Merged "Stock" tab: an inner Catalog/Count toggle over the same two panels
// that used to be separate top-level tabs (Products + StockTakePanel below).
// stock_taker accounts can't edit the catalog, so they only ever see Count —
// no toggle is rendered for them since there's nothing to switch to.
function StockPanel({ products, currentUser, onChanged }: { products: Product[]; currentUser: User; onChanged: () => Promise<void> }) {
  const canEditCatalog = currentUser.role === "admin";
  const [view, setView] = useState<"catalog" | "count" | "yields">(canEditCatalog ? "catalog" : "count");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");

  // Reconciliation (auto-generating any missing barcode/item code) only
  // otherwise runs at server startup and after a CSV import — this lets
  // an admin fix it right now, from the running app, without needing
  // someone to restart the service first. stock_taker accounts can't
  // edit the catalog so skip straight to a plain refetch for them (the
  // endpoint is admin-only server-side too).
  const refreshStock = async () => {
    setRefreshing(true); setRefreshMsg("");
    try {
      if (canEditCatalog) {
        const { barcodeIds, itemCodeIds } = await api.products.reconcileCodes();
        const fixed = barcodeIds.length + itemCodeIds.length;
        if (fixed > 0) setRefreshMsg(`Generated ${fixed} missing code${fixed === 1 ? "" : "s"}.`);
      }
      await onChanged();
    } catch (err) {
      setRefreshMsg(err instanceof Error ? err.message : "Could not refresh.");
    } finally {
      setRefreshing(false);
      window.setTimeout(() => setRefreshMsg(""), 3500);
    }
  };

  return (
    <>
      <div className="order-type-toggle">
        {canEditCatalog && <button type="button" className={view === "catalog" ? "active" : "secondary"} onClick={() => setView("catalog")}>Catalog</button>}
        <button type="button" className={view === "count" ? "active" : "secondary"} onClick={() => setView("count")}>Count</button>
        <button type="button" className={view === "yields" ? "active" : "secondary"} onClick={() => setView("yields")}>Cut Estimates</button>
        <button type="button" className="secondary" onClick={() => void refreshStock()} disabled={refreshing} title="Reload stock from the server (and generate any missing barcode/item code)">
          <RefreshCw size={16} className={refreshing ? "spin" : ""} /> {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {refreshMsg && <span className="settings-hint">{refreshMsg}</span>}
      </div>
      {view === "catalog" && canEditCatalog && <Products products={products} onChanged={onChanged} />}
      {view === "count" && <StockTakePanel products={products} currentUser={currentUser} onChanged={onChanged} />}
      {view === "yields" && <PendingYieldsPanel onChanged={onChanged} />}
    </>
  );
}

// Review queue for cut-yield conversions (see product_yield_estimates /
// pending_yield_conversions) — each row is one raw-intake Weigh-In line
// that has an estimated cut breakdown waiting to be reviewed. Nothing here
// touches stock until "Apply" is clicked; the estimated kg per cut is
// editable first, since the estimate is a starting point, not what the
// butcher necessarily produced.
function PendingYieldsPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<PendingYieldConversion[]>([]);
  const [edits, setEdits] = useState<Record<number, Record<number, number>>>({});
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = () => { api.weighIn.pendingYields("pending").then(setPending).catch(() => undefined); };
  useEffect(() => { load(); }, []);

  const kgFor = (conv: PendingYieldConversion, item: PendingYieldConversion["items"][number]) =>
    edits[conv.id]?.[item.subProductId] ?? item.estimatedKg;

  const setKg = (convId: number, subProductId: number, kg: number) =>
    setEdits((cur) => ({ ...cur, [convId]: { ...cur[convId], [subProductId]: kg } }));

  const apply = async (conv: PendingYieldConversion) => {
    setBusyId(conv.id); setMessage("");
    try {
      const items = conv.items.map((i) => ({ subProductId: i.subProductId, kg: kgFor(conv, i) }));
      await api.weighIn.applyYield(conv.id, items);
      setMessage(`Applied — stock updated for ${conv.rawProductName}'s cuts.`);
      load();
      await onChanged().catch(() => undefined);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not apply conversion.");
    } finally { setBusyId(null); }
  };

  const dismiss = async (conv: PendingYieldConversion) => {
    if (!window.confirm(`Dismiss this estimate for ${conv.rawProductName}? No stock will be changed.`)) return;
    setBusyId(conv.id); setMessage("");
    try {
      await api.weighIn.dismissYield(conv.id);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not dismiss conversion.");
    } finally { setBusyId(null); }
  };

  if (pending.length === 0) {
    return <EmptyState title="No pending cut estimates" detail="These appear automatically when a Weigh-In line is logged for a raw item that has cut yield estimates configured (set them up in Stock > Catalog)." />;
  }

  return (
    <div className="panel">
      <h2>Cut estimates awaiting review</h2>
      <p className="settings-hint">Estimated from the raw item's configured yield %s — adjust the kg if the actual cutting differed, then apply.</p>
      {message && <div className="form-message">{message}</div>}
      <div className="pending-yield-list">
        {pending.map((conv) => (
          <div className="pending-yield-card" key={conv.id}>
            <div className="pending-yield-header">
              <strong>{conv.rawProductName}</strong>
              <span className="settings-hint">{conv.weightKgReceived}kg received{conv.locationName ? ` · ${conv.locationName}` : ""} · {new Date(conv.createdAt).toLocaleDateString(appSettings.locale)}</span>
            </div>
            <table>
              <thead><tr><th>Cut</th><th>Estimate</th><th>Apply as (kg)</th></tr></thead>
              <tbody>
                {conv.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.subProductName}</td>
                    <td>{item.yieldPct}% → {item.estimatedKg.toFixed(2)}kg</td>
                    <td>
                      <input
                        type="number" min="0" step="0.01" value={kgFor(conv, item)}
                        onChange={(e) => setKg(conv.id, item.subProductId, e.target.value ? Number(e.target.value) : 0)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <footer className="actions">
              <button type="button" className="danger" disabled={busyId === conv.id} onClick={() => void dismiss(conv)}>Dismiss</button>
              <button type="button" disabled={busyId === conv.id} onClick={() => void apply(conv)}>{busyId === conv.id ? "Applying…" : "Apply to stock"}</button>
            </footer>
          </div>
        ))}
      </div>
    </div>
  );
}

// Admin product catalog editor: add/edit/delete products, set price and
// low-stock threshold. CSV import/export lives in SettingsPanel, not here.
function Products({ products, onChanged }: { products: Product[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<ProductInput>(EMPTY_PRODUCT);
  const [stockMessage, setStockMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [weighScanOpen, setWeighScanOpen] = useState(false);
  const [missingCost, setMissingCost] = useState<Product[]>([]);
  const [yieldRows, setYieldRows] = useState<{ subProductId: number; yieldPct: number }[]>([]);
  const [yieldMessage, setYieldMessage] = useState("");
  // Deleting a product is permanent (soft-delete server-side, but hidden
  // from the catalog forever after) — PIN-gated the same as any other
  // permanent/reversal-requiring action in this app (see POS's line-removal).
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [labelPrefs, setLabelPrefsState] = useState<LabelPrefs>(loadLabelPrefs);
  const setLabelPrefs = (patch: Partial<LabelPrefs>) => {
    setLabelPrefsState((cur) => {
      const next = { ...cur, ...patch };
      localStorage.setItem(LABEL_PREFS_KEY, JSON.stringify(next));
      return next;
    });
  };
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);
  // Only non-raw-intake products make sense as a cut/sub-product — a raw
  // carcass isn't itself "yielded" from another raw carcass.
  const cuttableProducts = useMemo(() => products.filter((p) => !p.isRawIntake), [products]);

  const [search, setSearch] = useState("");
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.department.toLowerCase().includes(q) ||
      (p.barcode ?? "").toLowerCase().includes(q) ||
      (p.itemCode ?? "").toLowerCase().includes(q)
    );
  }, [products, search]);

  const loadMissingCost = () => { api.products.missingCost().then(setMissingCost).catch(() => undefined); };
  useEffect(() => { loadMissingCost(); }, []);

  // Yield estimates only apply to an already-saved raw-intake product (a
  // brand-new one has no id yet to attach them to) — refetched whenever a
  // different product is loaded into the form.
  useEffect(() => {
    if (editing.id && editing.isRawIntake) {
      api.products.yieldEstimates(editing.id)
        .then((rows) => setYieldRows(rows.map((r) => ({ subProductId: r.subProductId, yieldPct: r.yieldPct }))))
        .catch(() => setYieldRows([]));
    } else {
      setYieldRows([]);
    }
    setYieldMessage("");
  }, [editing.id, editing.isRawIntake]);

  const addYieldRow = () => setYieldRows((cur) => [...cur, { subProductId: cuttableProducts[0]?.id ?? 0, yieldPct: 0 }]);
  const updateYieldRow = (i: number, patch: Partial<{ subProductId: number; yieldPct: number }>) =>
    setYieldRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeYieldRow = (i: number) => setYieldRows((cur) => cur.filter((_, idx) => idx !== i));

  const saveYieldEstimates = async () => {
    if (!editing.id) return;
    setYieldMessage("");
    try {
      const saved = await api.products.setYieldEstimates(editing.id, yieldRows.filter((r) => r.subProductId && r.yieldPct > 0));
      setYieldRows(saved.map((r) => ({ subProductId: r.subProductId, yieldPct: r.yieldPct })));
      setYieldMessage("Yield estimates saved.");
    } catch (err) {
      setYieldMessage(err instanceof Error ? err.message : "Could not save yield estimates.");
    }
  };

  // Editing an existing row needs its current cost pulled in from the
  // derived Product.currentCost field (a different name/shape than
  // ProductInput.costPerUnit, which is "the value to write on save") —
  // otherwise the cost field would show blank for a product that already
  // has one recorded.
  const editProduct = (p: Product) => setEditing({ ...p, costPerUnit: p.currentCost });

  const belowCost = editing.pricePerUnit != null && editing.costPerUnit != null && editing.pricePerUnit < editing.costPerUnit;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = editing.name.trim();
    if (!name) { setStockMessage("Enter a name."); return; }
    // Required going forward for brand-new products only — an existing
    // product missing its cost isn't blocked from other edits here, it
    // just keeps showing up in "Products needing cost price" below until
    // someone deliberately fills it in (never silently defaulted to 0).
    if (!editing.id && (editing.costPerUnit == null || editing.costPerUnit === undefined)) {
      setStockMessage("Enter a cost price — required for new items.");
      return;
    }
    setBusy(true); setStockMessage("");
    try {
      const saved = await api.products.save({ ...editing, name, category: editing.category.trim() || "General", prepNotes: editing.prepNotes.trim() });
      // Stays populated with the saved product (rather than resetting to
      // EMPTY_PRODUCT) so a barcode auto-generated on this save — see
      // upsertProduct — is immediately visible/printable, not silently
      // applied somewhere the admin has to go looking for it.
      setEditing({ ...saved, costPerUnit: saved.currentCost });
      setStockMessage("Saved.");
      loadMissingCost();
    } catch (err) {
      setStockMessage(err instanceof Error ? err.message : "Could not save.");
      return;
    } finally { setBusy(false); }
    await onChanged().catch(() => undefined);
  };

  const remove = async (id: number) => {
    await api.products.delete(id);
    setPendingDelete(null);
    await onChanged();
  };

  // Deterministic by construction (see generateInternalBarcode) — this
  // isn't "generate a new one," it's "re-derive the same one and persist
  // it," for when a printed sticker is damaged/lost and needs reprinting,
  // or to force an existing product back onto the auto scheme.
  const regenerateBarcode = async () => {
    if (!editing.id) return;
    setBusy(true); setStockMessage("");
    try {
      // costPerUnit deliberately omitted — this action only changes the
      // barcode, and resubmitting the form's current cost value would
      // otherwise insert a needless duplicate cost_history row.
      const saved = await api.products.save({ ...editing, barcode: generateInternalBarcode(editing.id), costPerUnit: undefined });
      setEditing({ ...saved, costPerUnit: saved.currentCost });
      setStockMessage("Barcode regenerated.");
      await onChanged().catch(() => undefined);
    } catch (err) {
      setStockMessage(err instanceof Error ? err.message : "Could not regenerate barcode.");
    } finally { setBusy(false); }
  };

  const printSticker = () => {
    if (!editing.barcode) return;
    printHtml(buildBarcodeStickerHtml(
      { name: editing.name, category: editing.category, barcode: editing.barcode, pricePerUnit: editing.pricePerUnit, costPerUnit: editing.costPerUnit ?? null },
      labelPrefs
    ));
  };

  return (
    <div className="products-layout">
      {missingCost.length > 0 && (
        <div className="panel missing-cost-widget span-full">
          <h3>Products needing cost price ({missingCost.length})</h3>
          <p className="settings-hint">These are sellable via POS, but have never had a cost price recorded — margin reports can't account for them until one is entered.</p>
          <div className="missing-cost-list">
            {missingCost.map((p) => (
              <button type="button" key={p.id} className="missing-cost-chip" onClick={() => editProduct(p)}>{p.name}</button>
            ))}
          </div>
        </div>
      )}
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
          Sold by
          <select value={editing.unitDefault} onChange={(e) => setEditing({ ...editing, unitDefault: e.target.value as UnitDefault })}>
            <option value="kg">Weight (kg) — scale item, priced per kg</option>
            <option value="qty">Fixed unit (each) — barcoded item, priced per item</option>
          </select>
        </label>
        <label>
          {editing.unitDefault === "qty" ? "Sell price (each)" : "Sell price (R/kg)"}
          <input type="number" min="0" step="0.01" value={editing.pricePerUnit ?? ""} onChange={(e) => setEditing({ ...editing, pricePerUnit: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label>
          Cost price {!editing.id && <span className="optional-hint">(required)</span>}
          <input
            type="number" min="0" step="0.01" value={editing.costPerUnit ?? ""}
            onChange={(e) => setEditing({ ...editing, costPerUnit: e.target.value ? Number(e.target.value) : null })}
            placeholder={editing.id ? "Not yet recorded" : "Required for a new item"}
          />
        </label>
        {belowCost && (
          <p className="form-error">Sell price is below cost price — this item would sell at a loss.</p>
        )}
        <label>Prep notes<textarea value={editing.prepNotes} onChange={(e) => setEditing({ ...editing, prepNotes: e.target.value })} /></label>
        {editing.unitDefault === "qty" ? (
          <label>
            Barcode <span className="optional-hint">(optional — auto-generated on save if left blank)</span>
            <input value={editing.barcode ?? ""} onChange={(e) => setEditing({ ...editing, barcode: e.target.value })} placeholder="e.g. 6001234567890" />
            <p className="settings-hint">
              Enter (or scan) the product's real printed barcode. Leave this blank to have one generated automatically when you save
              (a fixed, scannable "29"-prefixed code derived from the item, distinct from real manufacturer barcodes).
            </p>
          </label>
        ) : (
          <label>
            Item code (scale PLU) <span className="optional-hint">(optional — auto-assigned on save if left blank)</span>
            <div className="barcode-field-row">
              <input value={editing.itemCode ?? ""} onChange={(e) => setEditing({ ...editing, itemCode: e.target.value })} placeholder="e.g. 00550" maxLength={5} />
              <button type="button" className="secondary sm" onClick={() => setWeighScanOpen(true)}><ScanLine size={16} /> Scan weigh-label</button>
            </div>
            <p className="settings-hint">
              A product sold by weight on the scale has no single barcode — the price changes every time it's weighed, so the barcode is
              different every label. This 5-digit item code is its stable identity instead. Leave it blank to have the system assign the
              next free code automatically (checked against every other product so none can collide); if this product's PLU is already
              programmed into the physical scale, enter that exact number instead, or use "Scan weigh-label" to read one off an existing
              label. Use the <b>Print Labels</b> tab to print a fresh weigh-barcode label for this product.
            </p>
          </label>
        )}
        {editing.id && editing.barcode && editing.unitDefault === "qty" && (
          <div className="barcode-preview">
            <BarcodeImage value={editing.barcode} />
            <div className="label-options">
              <label className="label-options-field">
                Label size
                <select value={labelPrefs.size} onChange={(e) => setLabelPrefs({ size: e.target.value as LabelSize })}>
                  <option value="50x30">50 x 30mm</option>
                  <option value="40x30">40 x 30mm</option>
                  <option value="38x25">38 x 25mm</option>
                </select>
              </label>
              <label className="label-options-field">
                Copies
                <input type="number" min="1" max="200" value={labelPrefs.copies} onChange={(e) => setLabelPrefs({ copies: Number(e.target.value) || 1 })} />
              </label>
              <label className="checkbox-label sm"><input type="checkbox" checked={labelPrefs.showPrice} onChange={(e) => setLabelPrefs({ showPrice: e.target.checked })} /> Price</label>
              <label className="checkbox-label sm"><input type="checkbox" checked={labelPrefs.showCategory} onChange={(e) => setLabelPrefs({ showCategory: e.target.checked })} /> Category</label>
              <label className="checkbox-label sm"><input type="checkbox" checked={labelPrefs.showCost} onChange={(e) => setLabelPrefs({ showCost: e.target.checked })} /> Cost price</label>
            </div>
            <div className="barcode-preview-actions">
              <button type="button" className="secondary sm" onClick={() => void regenerateBarcode()} disabled={busy}>Regenerate barcode</button>
              <button type="button" className="secondary sm" onClick={printSticker}><Printer size={16} /> Print {labelPrefs.copies > 1 ? `${labelPrefs.copies} stickers` : "sticker"}</button>
            </div>
          </div>
        )}
        <label>
          Low-stock threshold
          <input type="number" min="0" step="0.01" placeholder="No warning" value={editing.lowStockThreshold ?? ""} onChange={(e) => setEditing({ ...editing, lowStockThreshold: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={!!editing.isRawIntake} onChange={(e) => setEditing({ ...editing, isRawIntake: e.target.checked ? 1 : 0 })} />
          Raw meat intake item <span className="optional-hint">(shows up in Weigh-In — whole carcass/organ items only, e.g. Whole Forequarter, Liver, Oxtail)</span>
        </label>

        {editing.id && !!editing.isRawIntake && (
          <div className="yield-estimates">
            <strong>Cut yield estimates</strong>
            <p className="settings-hint">
              What % of this item's received weight typically becomes each cut (doesn't need to add up to 100% — the
              rest is bone/trim/waste). Logging a Weigh-In line for this item will queue an estimated stock increase
              for each cut below, reviewed and applied separately in Stock &gt; Cut Estimates — nothing is added
              automatically.
            </p>
            {yieldRows.map((row, i) => (
              <div className="yield-estimate-row" key={i}>
                <select value={row.subProductId} onChange={(e) => updateYieldRow(i, { subProductId: Number(e.target.value) })}>
                  {cuttableProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input
                  type="number" min="0" max="100" step="0.1" value={row.yieldPct || ""}
                  onChange={(e) => updateYieldRow(i, { yieldPct: e.target.value ? Number(e.target.value) : 0 })}
                  placeholder="%"
                />
                <button type="button" className="icon-button danger sm" onClick={() => removeYieldRow(i)} title="Remove" aria-label="Remove"><Trash2 size={16} /></button>
              </div>
            ))}
            <div className="yield-estimate-actions">
              <button type="button" className="secondary sm" onClick={addYieldRow} disabled={cuttableProducts.length === 0}><Plus size={16} /> Add cut</button>
              <button type="button" className="secondary sm" onClick={() => void saveYieldEstimates()}>Save estimates</button>
            </div>
            {yieldMessage && <p className="settings-hint">{yieldMessage}</p>}
          </div>
        )}

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
          <div className="search-bar-row">
            <div className="search-bar">
              <input placeholder="Search by name, category, dept, barcode or item code…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
            </div>
          </div>
          {filteredProducts.length === 0 ? (
            <EmptyState title="No matches" detail="No items match that search." />
          ) : (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Dept</th><th>Barcode</th><th>R/kg</th><th>On hand</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {filteredProducts.map((p) => {
                const low = p.lowStockThreshold != null && p.onHandQty <= p.lowStockThreshold;
                const isWeighed = p.unitDefault !== "qty";
                return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td><span className={`dept-badge ${p.department}`}>{p.department}</span></td>
                  <td className="mono">
                    {isWeighed
                      ? (p.itemCode ? `PLU ${p.itemCode}` : <span className="muted">No item code</span>)
                      : (p.barcode ?? <span className="muted">No barcode</span>)}
                  </td>
                  <td>{p.pricePerUnit ? currency.format(p.pricePerUnit) : ""}</td>
                  <td>{p.onHandQty}{low && <span className="low-stock-badge">Low</span>}</td>
                  <td>{p.prepNotes}</td>
                  <td className="row-actions">
                    <button type="button" className="secondary" onClick={() => editProduct(p)}>Edit</button>
                    <button type="button" className="icon-button danger" onClick={() => setPendingDelete({ id: p.id, name: p.name })} title="Delete" aria-label="Delete"><Trash2 size={18} /></button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      )}
      {weighScanOpen && (
        <WeighLabelScanModal
          onResolved={(itemCode, price) => {
            setEditing((cur) => ({ ...cur, itemCode }));
            setStockMessage(`Item code ${itemCode} filled in (this label was priced at ${currency.format(price)}, for reference only).`);
            setWeighScanOpen(false);
          }}
          onClose={() => setWeighScanOpen(false)}
        />
      )}
      {pendingDelete && (
        <PinConfirmModal
          title="Delete product?"
          message={`Enter your PIN to delete "${pendingDelete.name}". This cannot be undone.`}
          onConfirm={() => void remove(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// Renders a scannable barcode image so an admin can visually verify it
// (right digits, right symbology) before printing a sticker — not just
// trust the raw digit string. JsBarcode draws directly into the <svg> via
// its DOM ref rather than through React children, so this needs an effect.
function BarcodeImage({ value }: { value: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    try {
      JsBarcode(svgRef.current, value, { format: "EAN13", displayValue: true, height: 60, margin: 8 });
    } catch {
      // Not a valid EAN-13 (e.g. a hand-typed manual barcode of another
      // length/symbology) — leave the image blank rather than throwing;
      // the raw value is still shown in the text field above.
    }
  }, [value]);
  return <svg ref={svgRef} className="barcode-svg" />;
}

// Scans a scale-generated weigh-label barcode (see parseWeighBarcode) and
// hands back just its PLU — used by the product catalog form so an admin
// never has to manually work out which 5 digits of a 13-digit scan are the
// actual item code. Deliberately separate from BarcodeAddModal: that one
// resolves a code against the product catalog (and offers quick-create),
// which isn't the job here — here the barcode IS the product being edited.
function WeighLabelScanModal({ onResolved, onClose }: { onResolved: (itemCode: string, price: number) => void; onClose: () => void }) {
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  // Native support doesn't depend on any browser feature check, so it's
  // known synchronously up front — used only to pick a sensible initial
  // mode (auto-start "scan" whenever some form of camera scanning is
  // available at all) before useBarcodeScan itself has run.
  const initialCameraSupport = Capacitor.isNativePlatform() || (typeof navigator !== "undefined" && !!navigator.mediaDevices && "BarcodeDetector" in window);
  const [mode, setMode] = useState<"scan" | "manual">(initialCameraSupport ? "scan" : "manual");

  const handleCode = (code: string) => {
    const weigh = parseWeighBarcode(code);
    if (!weigh) { setError(`"${code}" isn't a recognized scale weigh-label barcode.`); return; }
    onResolved(weigh.itemCode, weigh.price);
  };

  const { videoRef, isNative, cameraSupported } = useBarcodeScan({
    active: mode === "scan",
    onDetected: handleCode,
    onError: (message) => { setError(message); setMode("manual"); }
  });

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setError("");
    handleCode(manualCode.trim());
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>Scan weigh-label</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {mode === "scan" ? (
          <div className="modal-body barcode-scan">
            {isNative
              ? <p className="settings-hint">Opening the camera…</p>
              : <><video ref={videoRef} className="barcode-video" muted playsInline /><p className="settings-hint">Point the camera at a printed scale label for this item.</p></>}
            <button type="button" className="secondary" onClick={() => setMode("manual")}>Enter code manually instead</button>
          </div>
        ) : (
          <form className="modal-body" onSubmit={submitManual}>
            <label>Full barcode from the label
              <input inputMode="numeric" autoFocus value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="e.g. 2000550070568" />
            </label>
            <footer className="actions">
              {cameraSupported && <button type="button" className="secondary" onClick={() => setMode("scan")}>Use camera instead</button>}
              <button type="submit" disabled={!manualCode.trim()}>Decode</button>
            </footer>
          </form>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

// ── Stock take ────────────────────────────────────────────────────────────────
// Physical stock counting, per location. Nobody types a new total directly —
// everyone (admin included) enters what they physically counted, and the
// server works out and applies the resulting change itself (see
// db.recordStockCount). Admin additionally manages the list of locations.

function StockTakePanel({ products, currentUser, onChanged }: { products: Product[]; currentUser: User; onChanged: () => Promise<void> }) {
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState<number | "">("");
  const [rows, setRows] = useState<ProductStockRow[]>([]);
  const [msg, setMsg] = useState("");
  const [newLocationName, setNewLocationName] = useState("");
  const [addingLocation, setAddingLocation] = useState(false);
  // PIN-gated, same bar as any other permanent/reversal-adjacent action —
  // removing a location affects every product counted against it.
  const [pendingRemoveLocation, setPendingRemoveLocation] = useState<StockLocation | null>(null);

  const loadLocations = () =>
    api.stock.locations.list().then((locs) => {
      setLocations(locs);
      setLocationId((cur) => cur || locs[0]?.id || "");
    }).catch(() => undefined);

  useEffect(() => { void loadLocations(); }, []);

  const loadRows = () => {
    if (!locationId) { setRows([]); return; }
    api.stock.forLocation(locationId).then(setRows).catch(() => undefined);
  };

  useEffect(() => { loadRows(); }, [locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [search, setSearch] = useState("");
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.productName.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
  }, [rows, search]);

  const submitCount = async (productId: number, value: string) => {
    if (!locationId || value === "") return;
    const qty = Number(value);
    if (Number.isNaN(qty) || qty < 0) return;
    try {
      await api.stock.recordCount(productId, locationId, qty);
      setMsg("Count saved.");
      loadRows();
      await onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save count.");
    } finally {
      window.setTimeout(() => setMsg(""), 2500);
    }
  };

  const addLocation = async (e: FormEvent) => {
    e.preventDefault();
    if (!newLocationName.trim()) return;
    setAddingLocation(true);
    try {
      const loc = await api.stock.locations.create(newLocationName);
      setNewLocationName("");
      await loadLocations();
      setLocationId(loc.id);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not add location.");
    } finally {
      setAddingLocation(false);
    }
  };

  const removeLocation = async (id: number) => {
    await api.stock.locations.deactivate(id);
    setPendingRemoveLocation(null);
    await loadLocations();
  };

  if (products.length === 0) {
    return <EmptyState title="No items yet" detail="An admin needs to add items in Stock before they can be counted here." />;
  }

  const thresholdByProductId = new Map(products.map((p) => [p.id, p.lowStockThreshold]));

  return (
    <div className="products-layout">
      {currentUser.role === "admin" && (
        <form className="panel product-form" onSubmit={(e) => void addLocation(e)}>
          <h2>Stock locations</h2>
          <p className="settings-hint">The physical places stock is kept — Cold Room, Counter, Freezer 2, etc.</p>
          <label>New location<input value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} placeholder="e.g. Cold Room" /></label>
          <footer className="actions">
            <button type="submit" disabled={addingLocation || !newLocationName.trim()}>{addingLocation ? "Adding…" : "Add location"}</button>
          </footer>
          {locations.length > 0 && (
            <ul className="location-list">
              {locations.map((l) => (
                <li key={l.id}>
                  <span>{l.name}</span>
                  <button type="button" className="icon-button danger" title="Remove location" aria-label="Remove location" onClick={() => setPendingRemoveLocation(l)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}

      <div className="panel table-panel span-full">
        <div className="report-controls">
          <label>Counting at
            <select value={locationId} onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : "")}>
              {locations.length === 0 && <option value="">— No locations yet —</option>}
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>
        <p className="settings-hint">Enter what you physically count for each item — the system works out and applies the change itself.</p>
        {msg && <div className="form-message">{msg}</div>}
        <div className="search-bar-row">
          <div className="search-bar">
            <input placeholder="Search by name or category…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <button type="button" className="search-clear" onClick={() => setSearch("")}>×</button>}
          </div>
        </div>
        {filteredRows.length === 0 ? (
          <EmptyState title="No matches" detail="No items match that search." />
        ) : (
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Current</th><th>Count</th><th>Last counted</th></tr></thead>
          <tbody>
            {filteredRows.map((r) => {
              const threshold = thresholdByProductId.get(r.productId);
              const low = threshold != null && r.qty <= threshold;
              return (
                <tr key={r.productId}>
                  <td>{r.productName}</td>
                  <td>{r.category}</td>
                  <td>{r.qty}{low && <span className="low-stock-badge">Low</span>}</td>
                  <td>
                    <input
                      type="number" min="0" step="0.01" placeholder="Count…"
                      key={`${r.productId}-${locationId}-${r.qty}`}
                      onBlur={(e) => void submitCount(r.productId, e.target.value)}
                    />
                  </td>
                  <td className="settings-hint">
                    {r.lastCountedAt
                      ? `${new Date(r.lastCountedAt).toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" })}${r.lastCountedByName ? ` — ${r.lastCountedByName}` : ""}`
                      : "Never"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>
      {pendingRemoveLocation && (
        <PinConfirmModal
          title="Remove location?"
          message={`Enter your PIN to remove "${pendingRemoveLocation.name}". Its stock history is kept, but it won't be countable against anymore.`}
          onConfirm={() => void removeLocation(pendingRemoveLocation.id)}
          onCancel={() => setPendingRemoveLocation(null)}
        />
      )}
    </div>
  );
}

// ── Weigh-in (batch) ──────────────────────────────────────────────────────────
// Stock-in workflow: the stock taker logs incoming deliveries one line at a
// time into an open batch, then finalizes it to lock the batch and print a
// summary. See buildWeighInSummaryHtml below for how the printout is built.

const GRADE_LETTERS: ("A" | "B" | "C")[] = ["A", "B", "C"];
// Per-item defaults for "pieces received", matched by exact lowercased name;
// anything not listed falls back to 2 (defaultPiecesFor's `|| 2`). Both
// "Whole Forequarter" and "Beef Forequarter" are listed since existing
// installs may have named the product either way (see the migration in
// database.ts that flags pre-existing products as raw intake by name).
const ITEM_PIECE_DEFAULTS: Record<string, number> = { "whole forequarter": 2, "beef forequarter": 2, "whole lamb": 8 };
const defaultPiecesFor = (name: string | undefined) => (name && ITEM_PIECE_DEFAULTS[name.trim().toLowerCase()]) || 2;
const isWholeLamb = (name: string | undefined) => (name ?? "").trim().toLowerCase() === "whole lamb";
const isLambHind = (name: string | undefined) => (name ?? "").trim().toLowerCase() === "lamb hind";

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
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [msg, setMsg] = useState("");
  const [history, setHistory] = useState<WeighInBatchSummary[]>([]);
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  // Deleting a line reverses its stock adjustment — PIN-gated like any
  // other permanent, stock-reversing action in this app.
  const [pendingDeleteLine, setPendingDeleteLine] = useState(false);

  const loadCurrent = () => api.weighIn.current().then((r) => setLines(r.lines)).catch(() => undefined);
  const loadSuppliers = () => api.suppliers.list().then(setSuppliers).catch(() => undefined);
  const loadLocations = () =>
    api.stock.locations.list().then((locs) => {
      setLocations(locs);
      setLocationId((cur) => cur || locs[0]?.id || "");
    }).catch(() => undefined);
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

  useEffect(() => { void loadCurrent(); void loadSuppliers(); void loadLocations(); loadHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Only the whole-carcass/organ items the butchery actually takes delivery
  // of are selectable here — everything else is received some other way.
  // Whole Forequarter/Beef Forequarter and Whole Lamb are the highest-volume
  // items, so they're always pinned first (in that order) ahead of the rest.
  // Lamb Hind is deliberately left out of this list — it's logged via the
  // "Also log Lamb Hind" co-entry below when Whole Lamb is selected, not
  // picked as its own item, so it can't accidentally be logged on its own
  // disconnected from the lamb delivery it came with.
  const rawIntakeProducts = useMemo(() => products.filter((p) => p.isRawIntake && !isLambHind(p.name)), [products]);
  const lambHindProduct = useMemo(() => products.find((p) => p.isRawIntake && isLambHind(p.name)), [products]);
  const orderedItemOptions = useMemo(() => {
    const pinnedNames = Object.keys(ITEM_PIECE_DEFAULTS);
    const byLowerName = (n: string) => n.trim().toLowerCase();
    const pinned = pinnedNames
      .map((name) => rawIntakeProducts.find((p) => byLowerName(p.name) === name))
      .filter((p): p is Product => Boolean(p));
    const pinnedIds = new Set(pinned.map((p) => p.id));
    return [...pinned, ...rawIntakeProducts.filter((p) => !pinnedIds.has(p.id))];
  }, [rawIntakeProducts]);

  const selectedProduct = products.find((p) => p.id === productId);
  const [hindPieces, setHindPieces] = useState(1);
  const [hindWeightKg, setHindWeightKg] = useState("");

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
    setLocationId(line.locationId);
    setNewSupplierName("");
    setMsg("");
  };

  const cancelEdit = () => {
    setEditingLineId(null);
    setProductId(""); setGrades({ A: false, B: false, C: false }); setPieces(2); setWeightKg("");
    setHindPieces(1); setHindWeightKg("");
    setMsg("");
  };

  const deleteLine = async () => {
    if (!editingLineId) return;
    setBusy(true);
    try {
      await api.weighIn.deleteLine(editingLineId);
      setLines((cur) => cur.filter((l) => l.id !== editingLineId));
      cancelEdit();
      setPendingDeleteLine(false);
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
    if (!locationId) { setMsg("Pick a location."); return; }

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

      const input = { productId, grade, piecesReceived: pieces, weightKg: weight, supplierId: finalSupplierId as number, locationId: locationId as number };
      if (wasEditing) {
        const updated = await api.weighIn.updateLine(wasEditing, input);
        setLines((cur) => cur.map((l) => (l.id === updated.id ? updated : l)));
        setEditingLineId(null);
        setProductId(""); setGrades({ A: false, B: false, C: false }); setPieces(2); setWeightKg("");
        setMsg("Line updated.");
      } else {
        const line = await api.weighIn.addLine(input);
        const newLines = [line];

        // Whole Lamb's hind is sold on as-is, never processed — logged as
        // its own separate line (same grade/supplier as the lamb it came
        // with) right alongside it, rather than as a follow-up someone has
        // to remember to do later.
        const hindWeight = parseFloat(hindWeightKg);
        if (isWholeLamb(selectedProduct?.name) && lambHindProduct && hindPieces > 0 && hindWeight > 0) {
          const hindLine = await api.weighIn.addLine({ productId: lambHindProduct.id, grade, piecesReceived: hindPieces, weightKg: hindWeight, supplierId: finalSupplierId as number, locationId: locationId as number });
          newLines.push(hindLine);
        }

        setLines((cur) => [...cur, ...newLines]);
        // Item and grade stay selected as defaults for the next line — only weight/pieces reset
        setPieces(defaultPiecesFor(products.find((p) => p.id === productId)?.name)); setWeightKg("");
        setHindPieces(1); setHindWeightKg("");
        setMsg(newLines.length > 1 ? "Logged (with Lamb Hind)." : "Logged.");
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
        {!editingLineId && isWholeLamb(selectedProduct?.name) && lambHindProduct && (
          <div className="hind-coentry">
            <p className="settings-hint">Also log the Lamb Hind from this delivery (sold on as-is, not processed) — same grade &amp; supplier as above.</p>
            <label>
              Hind pieces
              <div className="stepper-row">
                <button type="button" className="secondary sm" onClick={() => setHindPieces((p) => Math.max(1, p - 1))}>−</button>
                <input type="number" inputMode="numeric" min="1" step="1" value={hindPieces} onChange={(e) => setHindPieces(Math.max(1, Number(e.target.value)))} />
                <button type="button" className="secondary sm" onClick={() => setHindPieces((p) => p + 1)}>+</button>
              </div>
            </label>
            <label>
              Hind weight (kg) <span className="optional-hint">(leave blank to skip)</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={hindWeightKg} onChange={(e) => setHindWeightKg(e.target.value)} placeholder="0.00" />
            </label>
          </div>
        )}
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
        <label>
          Location
          <select value={locationId} onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">— Select location —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        {msg && <div className="form-message">{msg}</div>}
        <footer className="actions">
          {editingLineId && <button type="button" className="secondary danger" onClick={() => setPendingDeleteLine(true)} disabled={busy}>Delete line</button>}
          {editingLineId && <button type="button" className="secondary" onClick={cancelEdit}>Cancel</button>}
          <button type="submit" disabled={busy || cooldown}>
            <Save size={18} /> {busy ? "Saving…" : cooldown ? "Wait…" : editingLineId ? "Update line" : "Add line"}
          </button>
        </footer>
      </form>

      <div className="panel table-panel">
        <h2>Current batch</h2>
        <table>
          <thead><tr><th>Date</th><th>Item</th><th>Grade</th><th>Pieces</th><th>Kg</th><th>Supplier</th><th>Location</th><th></th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={l.id === editingLineId ? "editing-row" : ""}>
                <td>{new Date(l.createdAt).toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{l.productName}</td>
                <td>{l.grade}</td>
                <td>{l.piecesReceived}</td>
                <td>{l.weightKg}</td>
                <td>{l.supplierName}</td>
                <td>{l.locationName}</td>
                <td className="row-actions">
                  <button type="button" className="secondary sm" onClick={() => startEdit(l)}>Edit</button>
                </td>
              </tr>
            ))}
            {lines.length > 0 && (
              <tr className="totals-row"><td colSpan={3}><b>Total</b></td><td><b>{totals.pieces}</b></td><td><b>{totals.weightKg.toFixed(2)}</b></td><td></td><td></td><td></td></tr>
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
      {pendingDeleteLine && (
        <PinConfirmModal
          title="Delete line?"
          message="Enter your PIN to delete this line. This cannot be undone and will reverse its stock adjustment."
          onConfirm={() => void deleteLine()}
          onCancel={() => setPendingDeleteLine(false)}
        />
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
  // PIN-gated like any other permanent/lockout-risking action — only the
  // deactivate direction needs it (see toggleActive below).
  const [pendingDeactivate, setPendingDeactivate] = useState<User | null>(null);

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
    // Only PIN-gate the deactivate direction — reactivating is harmless and
    // shouldn't need a prompt. Sits right next to "Edit" in a compact row,
    // so a mis-tap here would otherwise lock someone out with no warning.
    if (user.isActive) { setPendingDeactivate(user); return; }
    try {
      await api.users.update(user.id, { isActive: 1 });
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not update user");
    }
  };

  const confirmDeactivate = async (user: User) => {
    try {
      await api.users.update(user.id, { isActive: 0 });
      setPendingDeactivate(null);
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
      {pendingDeactivate && (
        <PinConfirmModal
          title="Deactivate user?"
          message={`Enter your PIN to deactivate ${pendingDeactivate.name}. They won't be able to log in until reactivated.`}
          confirmLabel="Confirm deactivation"
          onConfirm={() => void confirmDeactivate(pendingDeactivate)}
          onCancel={() => setPendingDeactivate(null)}
        />
      )}
    </div>
  );
}

// ── CRM (admin) ───────────────────────────────────────────────────────────────

const CONSENT_LABEL: Record<ConsentStatus, string> = { opted_in: "Opted in", opted_out: "Opted out", unknown: "Unknown" };

function CrmPanel() {
  const [view, setView] = useState<"contacts" | "email">("contacts");
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Distinguishes "still loading" from "loaded, zero results" — without
  // this, the empty-state text flashes on every mount/search keystroke
  // before the fetch resolves.
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.crm.contacts(search).then(setContacts).catch(() => undefined).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (view !== "contacts") return;
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [search, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <button type="button" className={view === "contacts" ? "active" : "secondary"} onClick={() => setView("contacts")}>WhatsApp Contacts</button>
      <button type="button" className={view === "email" ? "active" : "secondary"} onClick={() => setView("email")}>Email Marketing List</button>
    </div>
  );

  // Both the marketing-list view and the plain contact list (no detail
  // pane open) are a single panel — .products-layout's grid is built for
  // the products page's narrow-form-plus-wide-list split and would squeeze
  // a lone panel into its 340px first column, so it's only used below once
  // a contact is actually selected and there are two columns to lay out.
  if (view === "email") return <div className="panel table-panel">{tabs}<EmailSubscribersPanel /></div>;

  // Only the true "no contacts exist at all" case (no active search)
  // replaces the whole panel, matching every other list panel's EmptyState
  // convention (see HistoryView/StockTakePanel) — a search that matches
  // nothing keeps the search box visible with an inline "no matches" row,
  // same distinction those other panels make for their own filters.
  if (!loading && contacts.length === 0 && !search) {
    return <div className="panel table-panel">{tabs}<EmptyState title="No contacts yet" detail="Captured automatically from POS checkout or inbound WhatsApp messages." /></div>;
  }

  const list = (
    <div className="panel table-panel">
      {tabs}
      <div className="crm-search">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, or tag…" />
      </div>
      <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Tags</th><th>Consent</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="muted">Loading…</td></tr>}
            {!loading && contacts.map((c) => (
              <tr key={c.id} className={selectedId === c.id ? "active-row" : ""} onClick={() => setSelectedId(c.id)} style={{ cursor: "pointer" }}>
                <td>{c.fullName || <span className="muted">Unnamed</span>}</td>
                <td>{c.phoneNumber}</td>
                <td>{c.tags.join(", ")}</td>
                <td><span className={`consent-badge consent-${c.consentStatus}`}>{CONSENT_LABEL[c.consentStatus]}</span></td>
              </tr>
            ))}
            {!loading && contacts.length === 0 && <tr><td colSpan={4} className="muted">No contacts match your search.</td></tr>}
          </tbody>
      </table>
    </div>
  );

  if (!selectedId) return list;

  return (
    <div className="products-layout">
      {list}
      <CrmContactDetailPanel contactId={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
    </div>
  );
}

// Email marketing list: subscribers auto-captured from order checkouts
// (see db.upsertEmailSubscriber), manually addable, and the target of a
// one-off news/deals broadcast — independent of the WhatsApp contacts
// above and of the order-notification emails in Settings.
function EmailSubscribersPanel() {
  const [subs, setSubs] = useState<EmailSubscriber[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<"plain" | "discount">("plain");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [headline, setHeadline] = useState("");
  const [discountLabel, setDiscountLabel] = useState("");
  const [description, setDescription] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState("");
  const promoImageInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    api.emailSubscribers.list().then(setSubs).catch(() => undefined).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const subscribedCount = subs.filter((s) => s.status === "subscribed").length;

  const addSub = async () => {
    if (!/\S+@\S+\.\S+/.test(newEmail)) return;
    setAdding(true);
    try { await api.emailSubscribers.add(newEmail.trim(), newName.trim()); setNewEmail(""); setNewName(""); load(); }
    finally { setAdding(false); }
  };

  const toggleStatus = async (s: EmailSubscriber) => {
    await api.emailSubscribers.setStatus(s.id, s.status === "subscribed" ? "unsubscribed" : "subscribed");
    load();
  };

  const remove = async (id: string) => {
    await api.emailSubscribers.remove(id);
    load();
  };

  const uploadPromoImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { imageUrl: uploaded } = await api.emailSubscribers.uploadCampaignImage(dataUrl);
      setImageUrl(uploaded);
    } catch (err) {
      setSendResult(err instanceof Error ? err.message : "Image upload failed");
    } finally {
      setUploadingImage(false);
      if (promoImageInputRef.current) promoImageInputRef.current.value = "";
    }
  };

  const discountHasContent = headline.trim() || discountLabel.trim() || description.trim() || imageUrl;
  const canSend = mode === "plain" ? subject.trim() && body.trim() : subject.trim() && discountHasContent;

  const sendCampaign = async () => {
    if (!canSend) return;
    setSending(true); setSendResult("");
    try {
      const promo = mode === "discount"
        ? { headline: headline.trim() || undefined, discountLabel: discountLabel.trim() || undefined, description: description.trim() || undefined, validUntil: validUntil || undefined, imageUrl: imageUrl || undefined }
        : undefined;
      const result = await api.emailSubscribers.sendCampaign(subject.trim(), body.trim(), promo);
      setSendResult(`Queued for ${result.queued} subscriber${result.queued === 1 ? "" : "s"}.`);
      setSubject(""); setBody(""); setHeadline(""); setDiscountLabel(""); setDescription(""); setValidUntil(""); setImageUrl("");
    } catch (err) {
      setSendResult(err instanceof Error ? err.message : "Failed to send campaign");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <strong>Send a campaign</strong>
        <p className="settings-hint">Send a news/deals email to every subscribed address below. Each recipient gets a working unsubscribe link. Logo/promo images only render in the email if a Public URL is set under Email notifications above.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className={mode === "plain" ? "active" : "secondary"} onClick={() => setMode("plain")}>Plain message</button>
          <button type="button" className={mode === "discount" ? "active" : "secondary"} onClick={() => setMode("discount")}>Discount banner (picture-style)</button>
        </div>
        <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />

        {mode === "discount" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input placeholder="Headline (e.g. Weekend Special)" value={headline} onChange={(e) => setHeadline(e.target.value)} />
              <input placeholder="Discount (e.g. 20% OFF)" value={discountLabel} onChange={(e) => setDiscountLabel(e.target.value)} />
            </div>
            <input placeholder="Short description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label className="settings-hint" style={{ margin: 0 }}>Valid until</label>
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input ref={promoImageInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => void uploadPromoImage(e)} />
              <button type="button" className="secondary" disabled={uploadingImage} onClick={() => promoImageInputRef.current?.click()}>
                {uploadingImage ? "Uploading…" : imageUrl ? "Replace promo image" : "Upload promo image"}
              </button>
              {imageUrl && <img src={assetUrl(imageUrl)} alt="Promo" style={{ height: 40, borderRadius: 4 }} />}
              {imageUrl && <button type="button" className="secondary" onClick={() => setImageUrl("")}>Remove</button>}
            </div>
            <textarea placeholder="Extra message below the banner (optional)" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        )}
        {mode === "plain" && <textarea placeholder="Message" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />}

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" disabled={sending || !canSend} onClick={() => void sendCampaign()}>
            {sending ? "Sending…" : `Send to ${subscribedCount} subscriber${subscribedCount === 1 ? "" : "s"}`}
          </button>
          {sendResult && <span className="muted">{sendResult}</span>}
        </div>
      </div>

      <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8, marginTop: 16 }}>
        <strong>Add a subscriber</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="Email address" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <button type="button" disabled={adding || !newEmail.trim()} onClick={() => void addSub()}>Add</button>
        </div>
      </div>

      <table style={{ marginTop: 16 }}>
        <thead><tr><th>Name</th><th>Email</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          {!loading && subs.length === 0 && <tr><td colSpan={5} className="muted">No subscribers yet — captured automatically once orders start carrying an email address.</td></tr>}
          {!loading && subs.map((s) => (
            <tr key={s.id}>
              <td>{s.name || <span className="muted">Unnamed</span>}</td>
              <td>{s.email}</td>
              <td>{s.source}</td>
              <td><span className={`consent-badge consent-${s.status === "subscribed" ? "opted_in" : "opted_out"}`}>{s.status === "subscribed" ? "Subscribed" : "Unsubscribed"}</span></td>
              <td style={{ display: "flex", gap: 8 }}>
                <button type="button" className="secondary" onClick={() => void toggleStatus(s)}>{s.status === "subscribed" ? "Unsubscribe" : "Resubscribe"}</button>
                <button type="button" className="secondary" onClick={() => void remove(s.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CrmContactDetailPanel({ contactId, onClose, onChanged }: { contactId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<CrmContactDetail | null>(null);
  const [tagsInput, setTagsInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [freeformBody, setFreeformBody] = useState("");
  const [templates, setTemplates] = useState<{ name: string; category: "utility" | "marketing"; bodyTemplate: string }[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  // Tracks which specific action is in flight (not just a shared boolean)
  // so each button can show its own "Saving…"/"Sending…" label rather than
  // every button flipping to the same text regardless of which one was
  // actually clicked — matches the busy-label convention used by every
  // other save/submit action in the app (LoginScreen, OrderEntry, etc).
  const [busyAction, setBusyAction] = useState<"save" | "consent" | "freeform" | "template" | null>(null);
  const busy = busyAction !== null;
  const [msg, setMsg] = useState("");

  const load = () => api.crm.contact(contactId).then((d) => {
    setDetail(d);
    setTagsInput(d.contact.tags.join(", "));
    setNotesInput(d.contact.notes ?? "");
    setNameInput(d.contact.fullName ?? "");
  }).catch(() => undefined);

  useEffect(() => {
    void load();
    void api.crm.templates().then(setTemplates).catch(() => undefined);
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) return <div className="panel">Loading…</div>;
  const { contact, messages, withinServiceWindow } = detail;

  const saveDetails = async () => {
    setBusyAction("save"); setMsg("");
    try {
      await api.crm.updateContact(contact.id, {
        fullName: nameInput.trim() || null,
        notes: notesInput.trim() || null,
        tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean)
      });
      setMsg("Saved.");
      await load();
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to save");
    } finally { setBusyAction(null); }
  };

  const setConsent = async (status: ConsentStatus) => {
    setBusyAction("consent"); setMsg("");
    try {
      await api.crm.setConsent(contact.id, status);
      await load();
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to update consent");
    } finally { setBusyAction(null); }
  };

  const sendFreeform = async () => {
    if (!freeformBody.trim()) return;
    setBusyAction("freeform"); setMsg("");
    try {
      await api.crm.send(contact.id, { freeformBody: freeformBody.trim() });
      setFreeformBody("");
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to send");
    } finally { setBusyAction(null); }
  };

  const sendTemplate = async () => {
    if (!selectedTemplate) return;
    setBusyAction("template"); setMsg("");
    try {
      await api.crm.send(contact.id, { templateName: selectedTemplate });
      setSelectedTemplate("");
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to send");
    } finally { setBusyAction(null); }
  };

  // Marketing-tier templates can only ever be sent to opted_in contacts —
  // filtered out of the picker entirely rather than shown-but-disabled, to
  // keep the send box simple.
  const availableTemplates = templates.filter((t) => t.category !== "marketing" || contact.consentStatus === "opted_in");

  return (
    <div className="panel product-form crm-detail">
      <header className="crm-detail-header">
        <h2>{contact.fullName || contact.phoneNumber}</h2>
        <button type="button" className="secondary" onClick={onClose}><X size={16} /></button>
      </header>

      <label>Name<input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Not captured yet" /></label>
      <label>Notes<input value={notesInput} onChange={(e) => setNotesInput(e.target.value)} /></label>
      <label>Tags (comma-separated)<input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} /></label>
      <footer className="actions">
        <button type="button" disabled={busy} onClick={() => void saveDetails()}><Save size={16} /> {busyAction === "save" ? "Saving…" : "Save"}</button>
      </footer>

      <div className="crm-consent-row">
        <span>Consent: <b>{CONSENT_LABEL[contact.consentStatus]}</b></span>
        <div className="crm-consent-buttons">
          <button type="button" className="secondary" disabled={busy || contact.consentStatus === "opted_in"} onClick={() => void setConsent("opted_in")}>{busyAction === "consent" ? "Updating…" : "Opt in"}</button>
          <button type="button" className="secondary" disabled={busy || contact.consentStatus === "opted_out"} onClick={() => void setConsent("opted_out")}>{busyAction === "consent" ? "Updating…" : "Opt out"}</button>
        </div>
      </div>

      {msg && <div className="form-message">{msg}</div>}

      <h3>Messages</h3>
      <div className="crm-chat">
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.map((m: CrmMessage) => (
          <div key={m.id} className={`crm-chat-bubble ${m.direction}`}>
            <div className="crm-chat-body">{m.body}</div>
            <div className="crm-chat-meta">{new Date(m.createdAt).toLocaleString()} · {m.status}{m.templateName ? ` · ${m.templateName}` : ""}</div>
          </div>
        ))}
      </div>

      <div className="crm-send-box">
        {withinServiceWindow ? (
          <>
            <textarea value={freeformBody} onChange={(e) => setFreeformBody(e.target.value)} placeholder="Type a message…" rows={2} />
            <button type="button" disabled={busy || !freeformBody.trim()} onClick={() => void sendFreeform()}>{busyAction === "freeform" ? "Sending…" : "Send"}</button>
          </>
        ) : (
          <>
            <p className="settings-hint">Outside the 24h reply window — only an approved template can be sent.</p>
            <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
              <option value="">Choose a template…</option>
              {availableTemplates.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.category})</option>)}
            </select>
            <button type="button" disabled={busy || !selectedTemplate} onClick={() => void sendTemplate()}>{busyAction === "template" ? "Sending…" : "Send template"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Settings (admin) ──────────────────────────────────────────────────────────

// Auto-fills the SMTP host/port for the email providers a small business
// is most likely to already have an account with, so a non-technical admin
// never has to go looking up a mail server address — they pick their
// provider and fill in just their own email address + password.
const EMAIL_PROVIDER_PRESETS: Record<string, { host: string; port: string; help: string }> = {
  gmail: {
    host: "smtp.gmail.com", port: "587",
    help: "Use an App Password, not your normal Gmail password. Turn on 2-Step Verification in your Google Account, then create an App Password under Security → 2-Step Verification → App passwords, and paste that here."
  },
  outlook: {
    host: "smtp.office365.com", port: "587",
    help: "Use your normal Outlook/Office 365 email and password. If your organization enforces extra security, you may need an \"app password\" from your account's security settings instead."
  },
  yahoo: {
    host: "smtp.mail.yahoo.com", port: "587",
    help: "Yahoo requires an app password too: Account Info → Account Security → Generate app password."
  },
  custom: { host: "", port: "587", help: "Ask your email provider (or IT person) for their SMTP server address and port." }
};

// Admin control panel: printing config, branding (site name/logo/theme
// color — also pushed live into buildReceiptHtml via setReceiptBranding so
// printed receipts match immediately), product CSV import/export, and
// full-database backup/restore.
function SettingsPanel({ autoPrint, onAutoPrintChange, printStyle, onPrintStyleChange, printerMap, onPrinterMapChange, branding, onBrandingChange }: { autoPrint: boolean; onAutoPrintChange: (v: boolean) => void; printStyle: string; onPrintStyleChange: (v: string) => void; printerMap: Record<string, string>; onPrinterMapChange: (v: { kitchen: string; counter: string; master: string; label: string }) => void; branding: { siteName: string; logoUrl: string }; onBrandingChange: (b: { siteName: string; logoUrl: string }) => void }) {
  const [msg, setMsg] = useState("");
  const [availablePrinters, setAvailablePrinters] = useState<DiscoveredPrinter[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [historyDays, setHistoryDays] = useState(30);
  const [siteName, setSiteName] = useState(branding.siteName);
  const [themeColor, setThemeColor] = useState("#1a47a0");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [stockLocations, setStockLocations] = useState<StockLocation[]>([]);
  const [salesStockLocationId, setSalesStockLocationId] = useState("");
  const [vatRegistered, setVatRegistered] = useState(false);
  const [vatNumber, setVatNumber] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(false);
  const [emailOrderReadySubject, setEmailOrderReadySubject] = useState("");
  const [emailOrderReadyBody, setEmailOrderReadyBody] = useState("");
  const [emailPaymentReceivedSubject, setEmailPaymentReceivedSubject] = useState("");
  const [emailPaymentReceivedBody, setEmailPaymentReceivedBody] = useState("");
  // Email server (SMTP) connection details — the sensitive half of email
  // setup. Configurable here in Settings (no SSH/env-var editing needed),
  // but changing it requires PIN re-confirmation (see pendingEmailConfigSave)
  // since it's effectively an email account's login credentials. The
  // password itself is write-only: the server never sends the real value
  // back (see server/routes/settings.ts), only whether one is set.
  const [emailProvider, setEmailProvider] = useState("custom");
  const [emailSmtpHost, setEmailSmtpHost] = useState("");
  const [emailSmtpPort, setEmailSmtpPort] = useState("587");
  const [emailSmtpUser, setEmailSmtpUser] = useState("");
  const [emailSmtpPassInput, setEmailSmtpPassInput] = useState("");
  const [emailSmtpPassSet, setEmailSmtpPassSet] = useState(false);
  const [emailFromAddress, setEmailFromAddress] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  // Distinct from autoPrint (a prop, above) — that controls whether a NEW
  // order triggers printing automatically at all; this controls what a
  // MANUAL print button click does once triggered.
  const [forcePreview, setForcePreview] = useState(false);
  const [colorMode, setColorMode] = useState<"color" | "grayscale">("color");
  const [labelFormats, setLabelFormats] = useState<LabelFormat[]>([]);
  const [activeLabelSheetFormat, setActiveLabelSheetFormat] = useState("");
  const [savingEmailConfig, setSavingEmailConfig] = useState(false);
  const [pendingEmailConfigSave, setPendingEmailConfigSave] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState("");
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState("");
  const [iconVariant, setIconVariant] = useState<IconVariant>("IconDefault");
  const [savingIcon, setSavingIcon] = useState(false);
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

  // Native-only — reads back whichever activity-alias is currently the
  // enabled launcher icon, so the picker below opens already reflecting
  // reality instead of always defaulting to "Default."
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    iconSwitcher.getIcon().then(({ variant }) => setIconVariant(variant)).catch(() => undefined);
  }, []);

  const saveIcon = async (variant: IconVariant) => {
    setSavingIcon(true); setMsg("");
    try {
      await iconSwitcher.setIcon({ variant });
      setIconVariant(variant);
      setMsg("Icon updated — the home screen should reflect it within a few seconds, no reinstall needed.");
      window.setTimeout(() => setMsg(""), 4000);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to switch icon");
    } finally {
      setSavingIcon(false);
    }
  };

  useEffect(() => {
    api.settings.get().then((s) => {
      setHistoryDays(Number(s.historyDays ?? 30));
      setThemeColor(s.themeColor || "#1a47a0");
      setSalesStockLocationId(s.salesStockLocationId ?? "");
      setVatRegistered(s.vatRegistered === "true");
      setVatNumber(s.vatNumber ?? "");
      setBusinessAddress(s.businessAddress ?? "");
      setEmailNotificationsEnabled(s.emailNotificationsEnabled === "true");
      setEmailOrderReadySubject(s.emailOrderReadySubject ?? "");
      setEmailOrderReadyBody(s.emailOrderReadyBody ?? "");
      setEmailPaymentReceivedSubject(s.emailPaymentReceivedSubject ?? "");
      setEmailPaymentReceivedBody(s.emailPaymentReceivedBody ?? "");
      setEmailSmtpHost(s.emailSmtpHost ?? "");
      setEmailSmtpPort(s.emailSmtpPort || "587");
      setEmailSmtpUser(s.emailSmtpUser ?? "");
      setEmailSmtpPassSet(s.emailSmtpPassSet === "true");
      setEmailFromAddress(s.emailFromAddress ?? "");
      setPublicBaseUrl(s.publicBaseUrl ?? "");
      setForcePreview(s.printForcePreview === "true");
      setColorMode(s.printColorMode === "grayscale" ? "grayscale" : "color");
      setActiveLabelSheetFormat(s.activeLabelSheetFormat ?? "");
      // Pre-select the matching provider preset on load, so returning to
      // this screen doesn't just show "Other/custom" for a Gmail account
      // that was already set up.
      const matchedProvider = Object.entries(EMAIL_PROVIDER_PRESETS).find(([key, preset]) => key !== "custom" && preset.host === s.emailSmtpHost)?.[0];
      setEmailProvider(matchedProvider ?? (s.emailSmtpHost ? "custom" : "gmail"));
    }).catch(() => undefined);
    api.stock.locations.list().then(setStockLocations).catch(() => undefined);
    api.labels.formats().then(setLabelFormats).catch(() => undefined);
  }, []);

  const saveHistoryDays = async (days: number) => {
    await api.settings.set({ historyDays: String(days) });
    setHistoryDays(days);
    setMsg("History retention saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const saveSalesStockLocation = async (locationId: string) => {
    await api.settings.set({ salesStockLocationId: locationId });
    setSalesStockLocationId(locationId);
    setMsg("Sales stock location saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const saveVatRegistered = async (registered: boolean) => {
    setVatRegistered(registered);
    setReceiptBranding({ vatRegistered: registered });
    await api.settings.set({ vatRegistered: String(registered) });
    setMsg("VAT registration status saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const saveVatNumber = async (value: string) => {
    setVatNumber(value);
    setReceiptBranding({ vatNumber: value });
    await api.settings.set({ vatNumber: value });
  };

  const saveBusinessAddress = async (value: string) => {
    setBusinessAddress(value);
    setReceiptBranding({ businessAddress: value });
    await api.settings.set({ businessAddress: value });
  };

  const saveEmailNotificationsEnabled = async (enabled: boolean) => {
    setEmailNotificationsEnabled(enabled);
    await api.settings.set({ emailNotificationsEnabled: String(enabled) });
    setMsg(enabled ? "Email notifications enabled" : "Email notifications disabled");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const saveEmailTemplate = async (key: string, value: string) => {
    await api.settings.set({ [key]: value });
  };

  const applyEmailProvider = (provider: string) => {
    setEmailProvider(provider);
    const preset = EMAIL_PROVIDER_PRESETS[provider];
    if (preset && provider !== "custom") { setEmailSmtpHost(preset.host); setEmailSmtpPort(preset.port); }
  };

  // The actual write, run only after the PIN modal below confirms — never
  // called directly from a form control. Leaving the password field blank
  // keeps whatever's already saved (it's never sent back down to compare
  // against, so "unchanged" has to mean "don't overwrite").
  const confirmSaveEmailConfig = async () => {
    setSavingEmailConfig(true); setMsg("");
    try {
      const updates: Record<string, string> = {
        emailSmtpHost: emailSmtpHost.trim(),
        emailSmtpPort: emailSmtpPort.trim() || "587",
        emailSmtpUser: emailSmtpUser.trim(),
        emailFromAddress: emailFromAddress.trim()
      };
      if (emailSmtpPassInput.trim()) updates.emailSmtpPass = emailSmtpPassInput.trim();
      await api.settings.set(updates);
      if (emailSmtpPassInput.trim()) setEmailSmtpPassSet(true);
      setEmailSmtpPassInput("");
      setMsg("Email server settings saved.");
      window.setTimeout(() => setMsg(""), 3000);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to save email settings");
    } finally {
      setSavingEmailConfig(false);
      setPendingEmailConfigSave(false);
    }
  };

  const sendTestEmail = async () => {
    const to = testEmailTo.trim();
    if (!to) return;
    setSendingTestEmail(true); setTestEmailResult("");
    try {
      await api.settings.testEmail(to);
      setTestEmailResult(`Sent — check ${to}'s inbox (and spam folder).`);
    } catch (err) {
      setTestEmailResult(err instanceof Error ? err.message : "Test email failed to send");
    } finally {
      setSendingTestEmail(false);
    }
  };

  const saveSiteName = async (name: string) => {
    const trimmed = name.trim() || "NemenchPos";
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

  const toggleForcePreview = async () => {
    const next = !forcePreview;
    setForcePreview(next);
    await api.settings.set({ printForcePreview: String(next) });
    setPrintPrefs({ forcePreview: next });
    setMsg(next ? "Manual print now always shows a preview first" : "Manual print now sends straight to the assigned printer");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const changeColorMode = async (mode: "color" | "grayscale") => {
    setColorMode(mode);
    await api.settings.set({ printColorMode: mode });
    setPrintPrefs({ colorMode: mode });
    setMsg("Print color mode updated");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const changeActiveLabelSheetFormat = async (id: string) => {
    setActiveLabelSheetFormat(id);
    await api.settings.set({ activeLabelSheetFormat: id });
    setMsg("Default sticker sheet updated");
    window.setTimeout(() => setMsg(""), 2500);
  };

  const changePrinter = async (key: string, value: string) => {
    await api.settings.set({ [key]: value });
    onPrinterMapChange({ ...printerMap, [key.replace("Printer", "")]: value } as { kitchen: string; counter: string; master: string; label: string });
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
  // file (see database.ts's importBackup) — the most destructive single
  // action in the app, so it's PIN-gated the same as any other permanent
  // action rather than firing on file selection alone. The file is read
  // and parsed immediately (so a malformed file errors out right away),
  // but the actual restore only runs once the PIN is confirmed.
  const [pendingRestoreData, setPendingRestoreData] = useState<object | null>(null);

  const handleRestoreFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPendingRestoreData(JSON.parse(text) as object);
    } catch {
      setMsg("Restore failed: not a valid backup file");
      window.setTimeout(() => setMsg(""), 5000);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  const confirmRestore = async () => {
    if (!pendingRestoreData) return;
    setRestoring(true);
    try {
      const result = await api.backup.restore(pendingRestoreData);
      const totalRows = Object.values(result).filter((v): v is number => typeof v === "number").reduce((sum, v) => sum + v, 0);
      setMsg(`Restored: ${result.products} products, ${result.users} users, ${result.orders} orders, ${totalRows} rows total across all tables`);
      window.setTimeout(() => setMsg(""), 5000);
    } catch (err) {
      setMsg(`Restore failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      window.setTimeout(() => setMsg(""), 5000);
    } finally {
      setRestoring(false);
      setPendingRestoreData(null);
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
        <div className="setting-row">
          <div className="setting-info">
            <strong>Force print preview</strong>
            <p>When someone clicks a manual Print button, always open the print preview dialog instead of sending straight to the assigned printer. Doesn't affect auto-print on order creation, above.</p>
          </div>
          <button type="button" className={forcePreview ? "toggle-on" : "toggle-off"} onClick={() => void toggleForcePreview()}>
            {forcePreview ? "On" : "Off"}
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Print color</strong>
            <p>Applies to both receipts and labels, whether printed silently or via preview.</p>
          </div>
          <select className="settings-select" value={colorMode} onChange={(e) => void changeColorMode(e.target.value as "color" | "grayscale")}>
            <option value="color">Color</option>
            <option value="grayscale">Black &amp; white</option>
          </select>
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Sticker sheet currently loaded</strong>
            <p>Which label/sticker sheet is physically in the printer right now — Print Labels defaults to this until someone picks a different one for a specific job.</p>
          </div>
          <select className="settings-select" value={activeLabelSheetFormat} onChange={(e) => void changeActiveLabelSheetFormat(e.target.value)}>
            <option value="">— Not set —</option>
            {[...new Map(labelFormats.map((f) => [f.brand ?? "Other", true])).keys()].map((brand) => (
              <optgroup key={brand} label={brand}>
                {labelFormats.filter((f) => (f.brand ?? "Other") === brand).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </optgroup>
            ))}
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
            {availablePrinters.map((p) => <option key={p.name} value={p.name}>{p.ready ? p.name : `${p.name} (not set up yet)`}</option>)}
          </datalist>
          <div className="printer-assignments">
            {([ ["Kitchen printer", "kitchenPrinter", "kitchen"], ["Counter printer", "counterPrinter", "counter"], ["Master / cashier printer", "masterPrinter", "master"], ["Label / sticker printer", "labelPrinter", "label"] ] as [string, string, string][]).map(([label, key, mapKey]) => {
              const assigned = printerMap[mapKey] ?? "";
              const match = availablePrinters.find((p) => p.name === assigned);
              return (
                <div className="printer-row" key={key}>
                  <span className="printer-row-label">{label}</span>
                  <div className="printer-row-inputs">
                    <input
                      type="text"
                      list="printer-list"
                      placeholder="— Browser dialog —"
                      value={assigned}
                      onChange={(e) => void changePrinter(key, e.target.value)}
                      onBlur={(e) => void changePrinter(key, e.target.value)}
                    />
                    <button type="button" className="secondary sm" onClick={() => void printTestPage(assigned)}>
                      Test
                    </button>
                  </div>
                  {match && !match.ready && (
                    <p className="form-error">
                      "{match.name}" was only found on the network (mDNS), not yet set up in CUPS — printing to it will fail until it's added as a real print queue (see the commands below).
                    </p>
                  )}
                </div>
              );
            })}
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

      <section className="settings-section span-full">
        <h3>Products</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Product catalog</strong>
            <p>Import a CSV to bulk-add or update products (columns: name, category, unitDefault, pricePerUnit, prepNotes, department, costPerUnit. Sell price is also matched by "price"/"sellPrice"/"sellingPrice"/"unitPrice"/"retailPrice"; cost is optional but recommended, matched by "cost"/"costPerUnit"/"costPrice"). Export downloads the full product list, cost price included, as a CSV.</p>
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
            <input ref={restoreInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => void handleRestoreFileSelected(e)} />
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
            <img src={assetUrl(branding.logoUrl || "/logo.jpg")} alt="Current logo" className="login-logo" style={{ width: 40, height: 40 }} />
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

      <section className="settings-section">
        <h3>Tax &amp; Legal</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>VAT registered</strong>
            <p>Only enable this once actually registered with SARS — receipts print a VAT breakdown and VAT number only when this is on. Charging/claiming VAT without being registered is illegal.</p>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={vatRegistered} onChange={(e) => void saveVatRegistered(e.target.checked)} />
            Registered
          </label>
        </div>
        {vatRegistered && (
          <div className="setting-row">
            <div className="setting-info">
              <strong>VAT number</strong>
              <p>Printed on every receipt as required for a valid tax invoice.</p>
            </div>
            <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} onBlur={(e) => void saveVatNumber(e.target.value.trim())} placeholder="e.g. 4123456789" />
          </div>
        )}
        <div className="setting-row">
          <div className="setting-info">
            <strong>Business address</strong>
            <p>Physical business address, printed on receipts — required on a valid tax invoice.</p>
          </div>
          <textarea value={businessAddress} onChange={(e) => setBusinessAddress(e.target.value)} onBlur={(e) => void saveBusinessAddress(e.target.value.trim())} placeholder={"e.g. 12 Main Road\nSandton, 2196"} rows={2} />
        </div>
      </section>

      <section className="settings-section">
        <h3>Stock</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Sales stock location</strong>
            <p>When a POS sale is completed, its items are deducted from this location's stock. Leave unset to skip automatic deduction (e.g. if you'd rather rely on manual stock takes).</p>
          </div>
          <select className="settings-select" value={salesStockLocationId} onChange={(e) => void saveSalesStockLocation(e.target.value)}>
            <option value="">— Don't auto-deduct —</option>
            {stockLocations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
          </select>
        </div>
      </section>

      <section className="settings-section span-full">
        <h3>Email notifications</h3>
        <p className="settings-hint">Sends an email automatically when a customer gives an email address at checkout (POS or New Order) and their order becomes Ready, or (POS only) when payment is taken — completely independent of the WhatsApp/CRM system above. Two things are needed: an email account to send from (below), and this switched on.</p>

        <div className="setting-row">
          <div className="setting-info">
            <strong>1. Connect an email account</strong>
            <p>Pick the provider your business email is with. This fills in the technical server details for you — you only need to type in your own email address and its password.</p>
          </div>
          <select className="settings-select" value={emailProvider} onChange={(e) => applyEmailProvider(e.target.value)}>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook / Office 365</option>
            <option value="yahoo">Yahoo Mail</option>
            <option value="custom">Other / custom</option>
          </select>
        </div>
        <p className="settings-hint">{EMAIL_PROVIDER_PRESETS[emailProvider].help}</p>

        <div className="setting-row">
          <div className="setting-info"><strong>Email address</strong><p>The account you're sending from — also used as the "from" address customers see.</p></div>
          <input type="email" value={emailSmtpUser} onChange={(e) => { setEmailSmtpUser(e.target.value); setEmailFromAddress(e.target.value); }} placeholder="e.g. orders@yourbusiness.com" />
        </div>
        <div className="setting-row">
          <div className="setting-info"><strong>Password</strong><p>{emailSmtpPassSet ? "A password is already saved — leave this blank to keep it, or type a new one to replace it." : "See the note above the provider box if your provider needs an \"app password\" instead of your normal one."}</p></div>
          <input type="password" value={emailSmtpPassInput} onChange={(e) => setEmailSmtpPassInput(e.target.value)} placeholder={emailSmtpPassSet ? "Leave blank to keep current password" : "Password or app password"} />
        </div>
        {emailProvider === "custom" && (
          <>
            <div className="setting-row">
              <div className="setting-info"><strong>Server address</strong></div>
              <input value={emailSmtpHost} onChange={(e) => setEmailSmtpHost(e.target.value)} placeholder="e.g. smtp.yourprovider.com" />
            </div>
            <div className="setting-row">
              <div className="setting-info"><strong>Port</strong></div>
              <input value={emailSmtpPort} onChange={(e) => setEmailSmtpPort(e.target.value)} placeholder="587" />
            </div>
          </>
        )}
        <footer className="actions">
          <button type="button" disabled={savingEmailConfig || !emailSmtpHost.trim() || !emailSmtpUser.trim()} onClick={() => setPendingEmailConfigSave(true)}>
            {savingEmailConfig ? "Saving…" : "Save email account (PIN required)"}
          </button>
        </footer>

        <div className="setting-row">
          <div className="setting-info">
            <strong>Public URL</strong>
            <p>The real, public web address customers can reach (e.g. https://yourshop.com). Required for your logo and any campaign images to actually display in emails — email apps like Gmail and Outlook block embedded images and can't reach a local network address, so without this the logo/images are simply left out of emails rather than showing broken.</p>
          </div>
          <input value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)}
            onBlur={(e) => {
              const trimmed = e.target.value.trim().replace(/\/+$/, "");
              setPublicBaseUrl(trimmed);
              void saveEmailTemplate("publicBaseUrl", trimmed);
              setReceiptBranding({ publicBaseUrl: trimmed });
            }} placeholder="https://yourshop.com" />
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <strong>Send a test email</strong>
            <p>Confirms the saved settings actually work — sends a real email right now, no order needed. Do this once after saving above.</p>
          </div>
          <div className="test-email-row">
            <input type="email" value={testEmailTo} onChange={(e) => setTestEmailTo(e.target.value)} placeholder={emailFromAddress || "your@email.com"} />
            <button type="button" className="secondary" disabled={sendingTestEmail || !testEmailTo.trim()} onClick={() => void sendTestEmail()}>
              {sendingTestEmail ? "Sending…" : "Send test"}
            </button>
          </div>
        </div>
        {testEmailResult && <p className="settings-hint">{testEmailResult}</p>}

        <div className="setting-row">
          <div className="setting-info">
            <strong>2. Turn notifications on</strong>
            <p>Only takes effect once an email account is saved above.</p>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={emailNotificationsEnabled} onChange={(e) => void saveEmailNotificationsEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
        {emailNotificationsEnabled && (
          <>
            <p className="settings-hint">Placeholders: {"{{customerName}}"}, {"{{ticketNumber}}"}, {"{{amount}}"} (amount is only meaningful in the payment-received email), {"{{fulfillment}}"} (order-ready only — automatically says "ready for collection" or "out for delivery" depending on how the order was placed). Leave a subject blank to skip sending that event's email.</p>
            <div className="setting-row">
              <div className="setting-info"><strong>Order ready — subject</strong></div>
              <input value={emailOrderReadySubject} onChange={(e) => setEmailOrderReadySubject(e.target.value)}
                onBlur={(e) => void saveEmailTemplate("emailOrderReadySubject", e.target.value.trim())} placeholder="Your order is ready!" />
            </div>
            <div className="setting-row">
              <div className="setting-info"><strong>Order ready — body</strong></div>
              <textarea value={emailOrderReadyBody} onChange={(e) => setEmailOrderReadyBody(e.target.value)}
                onBlur={(e) => void saveEmailTemplate("emailOrderReadyBody", e.target.value.trim())} rows={3}
                placeholder="Hi {{customerName}}, your order #{{ticketNumber}} is {{fulfillment}}!" />
            </div>
            <div className="setting-row">
              <div className="setting-info"><strong>Payment received — subject</strong></div>
              <input value={emailPaymentReceivedSubject} onChange={(e) => setEmailPaymentReceivedSubject(e.target.value)}
                onBlur={(e) => void saveEmailTemplate("emailPaymentReceivedSubject", e.target.value.trim())} placeholder="Payment received" />
            </div>
            <div className="setting-row">
              <div className="setting-info"><strong>Payment received — body</strong></div>
              <textarea value={emailPaymentReceivedBody} onChange={(e) => setEmailPaymentReceivedBody(e.target.value)}
                onBlur={(e) => void saveEmailTemplate("emailPaymentReceivedBody", e.target.value.trim())} rows={3}
                placeholder="Hi {{customerName}}, we've received your payment of {{amount}} for order #{{ticketNumber}}. Thank you!" />
            </div>
          </>
        )}
        {pendingEmailConfigSave && (
          <PinConfirmModal
            title="Save email account?"
            message="Enter your PIN to save these email server settings — they control which account order notifications are sent from."
            confirmLabel="Save settings"
            onConfirm={() => void confirmSaveEmailConfig()}
            onCancel={() => setPendingEmailConfigSave(false)}
          />
        )}
      </section>

      {Capacitor.isNativePlatform() && (
        <section className="settings-section">
          <h3>App icon</h3>
          <div className="setting-row">
            <div className="setting-info">
              <strong>Home screen icon</strong>
              <p>Switches instantly on this device — no reinstall needed. Only these pre-built variants are available (not an arbitrary custom image).</p>
            </div>
            <select className="settings-select" value={iconVariant} disabled={savingIcon} onChange={(e) => void saveIcon(e.target.value as IconVariant)}>
              <option value="IconDefault">Default</option>
              <option value="IconAlt1">Alt 1</option>
              <option value="IconAlt2">Alt 2</option>
            </select>
          </div>
        </section>
      )}

      {msg && <div className="form-message">{msg}</div>}
      {pendingRestoreData && (
        <PinConfirmModal
          title="Restore backup?"
          message="Enter your PIN to replace ALL current data — products, users, orders, stock, CRM, everything — with this backup file. This cannot be undone."
          confirmLabel="Confirm restore"
          onConfirm={() => void confirmRestore()}
          onCancel={() => { setPendingRestoreData(null); if (restoreInputRef.current) restoreInputRef.current.value = ""; }}
        />
      )}
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
    a.download = `nemenchpos-orders-${from}-to-${to}.csv`;
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

// ── Statistics (admin) ───────────────────────────────────────────────────────
// Per-item sales performance (from orders) and stock movement (from
// Weigh-In receiving vs. live on-hand totals), over a date range — either
// a quick preset or a custom from/to, same pattern as Reports.

type SortDir = "asc" | "desc";
type SalesSortKey = "name" | "orderCount" | "totalQty" | "totalKg" | "totalRevenue";
type MoveSortKey = "productName" | "totalPiecesReceived" | "totalKgReceived" | "currentOnHand";
type MarginSortKey = "label" | "revenue" | "cost" | "profit" | "marginPct" | "qtySold";

function StatisticsPanel() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sales, setSales] = useState<ItemSalesStat[] | null>(null);
  const [movement, setMovement] = useState<ItemStockMovementStat[] | null>(null);
  const [overview, setOverview] = useState<StatisticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [salesSort, setSalesSort] = useState<{ key: SalesSortKey; dir: SortDir }>({ key: "totalRevenue", dir: "desc" });
  const [moveSort, setMoveSort] = useState<{ key: MoveSortKey; dir: SortDir }>({ key: "totalKgReceived", dir: "desc" });
  const [margins, setMargins] = useState<MarginOverview | null>(null);
  const [marginGroupBy, setMarginGroupBy] = useState<"product" | "category">("product");
  const [marginSort, setMarginSort] = useState<{ key: MarginSortKey; dir: SortDir }>({ key: "profit", dir: "desc" });

  const applyPreset = (preset: "today" | "week" | "month" | "all") => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (preset === "today") { setFrom(iso(now)); setTo(iso(now)); }
    else if (preset === "week") {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay());
      setFrom(iso(start)); setTo(iso(now));
    } else if (preset === "month") {
      setFrom(iso(new Date(now.getFullYear(), now.getMonth(), 1))); setTo(iso(now));
    } else {
      setFrom("2000-01-01"); setTo(iso(now));
    }
  };

  const load = async () => {
    if (from > to) { setError("'From' must be on or before 'To'"); return; }
    setLoading(true); setError("");
    try {
      const [s, m, o, mg] = await Promise.all([
        api.statistics.sales(from, to), api.statistics.stockMovement(from, to), api.statistics.overview(from, to),
        api.statistics.margins(from, to, marginGroupBy)
      ]);
      setSales(s); setMovement(m); setOverview(o); setMargins(mg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load statistics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Only re-fetches the margins breakdown (not the whole date-range
  // reload) when the grouping toggle changes — from/to stay the same.
  useEffect(() => {
    api.statistics.margins(from, to, marginGroupBy).then(setMargins).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marginGroupBy]);

  const sortedSales = useMemo(() => {
    const dir = salesSort.dir === "asc" ? 1 : -1;
    return [...(sales ?? [])].sort((a, b) =>
      salesSort.key === "name" ? a.name.localeCompare(b.name) * dir : (a[salesSort.key] - b[salesSort.key]) * dir
    );
  }, [sales, salesSort]);

  const sortedMovement = useMemo(() => {
    const dir = moveSort.dir === "asc" ? 1 : -1;
    return [...(movement ?? [])].sort((a, b) =>
      moveSort.key === "productName" ? a.productName.localeCompare(b.productName) * dir : (a[moveSort.key] - b[moveSort.key]) * dir
    );
  }, [movement, moveSort]);

  const toggleSalesSort = (key: SalesSortKey) =>
    setSalesSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const toggleMoveSort = (key: MoveSortKey) =>
    setMoveSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const sortedMargins = useMemo(() => {
    const dir = marginSort.dir === "asc" ? 1 : -1;
    return [...(margins?.current ?? [])].sort((a, b) =>
      marginSort.key === "label" ? a.label.localeCompare(b.label) * dir : (a[marginSort.key] - b[marginSort.key]) * dir
    );
  }, [margins, marginSort]);
  const toggleMarginSort = (key: MarginSortKey) =>
    setMarginSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const salesChartData = (sales ?? []).slice(0, 10).map((s) => ({ label: s.name, value: s.totalRevenue }));
  const salesRevenueTotal = (sales ?? []).reduce((sum, s) => sum + s.totalRevenue, 0);
  const movementChartData = (movement ?? []).filter((m) => m.totalKgReceived > 0).slice(0, 10).map((m) => ({ label: m.productName, value: m.totalKgReceived }));

  return (
    <div className="panel reports-panel">
      <h2>Statistics</h2>
      <div className="report-controls">
        <button type="button" className="secondary sm" onClick={() => applyPreset("today")}>Today</button>
        <button type="button" className="secondary sm" onClick={() => applyPreset("week")}>This Week</button>
        <button type="button" className="secondary sm" onClick={() => applyPreset("month")}>This Month</button>
        <button type="button" className="secondary sm" onClick={() => applyPreset("all")}>All Time</button>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "View"}</button>
      </div>
      {error && <div className="form-message">{error}</div>}

      {overview && (
        <>
          <div className="kpi-row">
            <KpiCard label="Revenue" value={overview.totalRevenue} prevValue={overview.prevRevenue} formatter={(v) => currency.format(v)} />
            <KpiCard label="Orders" value={overview.totalOrders} prevValue={overview.prevOrders} formatter={(v) => String(Math.round(v))} />
            <KpiCard label="Avg order value" value={overview.avgOrderValue} prevValue={overview.prevAvgOrderValue} formatter={(v) => currency.format(v)} />
            <KpiCard label="Kg sold" value={overview.totalKg} prevValue={null} formatter={(v) => `${v.toFixed(1)} kg`} />
          </div>

          <h3 className="stats-section-title">Revenue over time</h3>
          {overview.revenueByDay.every((d) => d.revenue === 0) ? (
            <p className="report-empty">No revenue in this range.</p>
          ) : (
            <RevenueTrendChart data={overview.revenueByDay} />
          )}

          <div className="stats-breakdown-grid">
            <div>
              <h3 className="stats-section-title">Revenue by department</h3>
              <BreakdownBars
                items={overview.revenueByDept.map((d) => ({ label: capitalize(d.department || "Unassigned"), value: d.revenue }))}
                valueFormatter={(v) => currency.format(v)}
              />
            </div>
            <div>
              <h3 className="stats-section-title">Revenue by order type</h3>
              <BreakdownBars
                items={overview.revenueByOrderType.map((d) => ({ label: capitalize(d.orderType || "Unspecified"), value: d.revenue }))}
                valueFormatter={(v) => currency.format(v)}
              />
            </div>
            <div>
              <h3 className="stats-section-title">Orders by status</h3>
              <BreakdownBars
                items={overview.ordersByStatus.map((d) => ({ label: d.status, value: d.count }))}
                valueFormatter={(v) => String(v)}
              />
            </div>
          </div>
        </>
      )}

      {margins && (
        <>
          <h3 className="stats-section-title">Profit margin</h3>
          <div className="kpi-row">
            <MarginSummaryCard current={margins.overallMarginPct} previous={margins.prevOverallMarginPct} />
          </div>

          {margins.trend.every((d) => d.revenue === 0) ? (
            <p className="report-empty">No costed sales in this range yet — items need a cost price recorded before they contribute to margin (see "Products needing cost price" in Stock).</p>
          ) : (
            <MarginTrendChart data={margins.trend} />
          )}

          <div className="report-controls">
            <button type="button" className={`secondary sm ${marginGroupBy === "product" ? "active" : ""}`} onClick={() => setMarginGroupBy("product")}>By item</button>
            <button type="button" className={`secondary sm ${marginGroupBy === "category" ? "active" : ""}`} onClick={() => setMarginGroupBy("category")}>By category</button>
          </div>

          {sortedMargins.length === 0 ? (
            <p className="report-empty">No costed sales in this range yet.</p>
          ) : (
            <div className="table-panel">
              <table>
                <thead>
                  <tr>
                    <SortableTh label={marginGroupBy === "category" ? "Category" : "Item"} active={marginSort.key === "label"} dir={marginSort.dir} onClick={() => toggleMarginSort("label")} />
                    <SortableTh label="Qty sold" active={marginSort.key === "qtySold"} dir={marginSort.dir} onClick={() => toggleMarginSort("qtySold")} />
                    <SortableTh label="Revenue" active={marginSort.key === "revenue"} dir={marginSort.dir} onClick={() => toggleMarginSort("revenue")} />
                    <SortableTh label="Cost" active={marginSort.key === "cost"} dir={marginSort.dir} onClick={() => toggleMarginSort("cost")} />
                    <SortableTh label="Profit" active={marginSort.key === "profit"} dir={marginSort.dir} onClick={() => toggleMarginSort("profit")} />
                    <SortableTh label="Margin %" active={marginSort.key === "marginPct"} dir={marginSort.dir} onClick={() => toggleMarginSort("marginPct")} />
                  </tr>
                </thead>
                <tbody>
                  {sortedMargins.map((m) => (
                    <tr key={m.id}>
                      <td>{m.label}</td>
                      <td>{m.qtySold ? m.qtySold.toFixed(2) : "—"}</td>
                      <td>{currency.format(m.revenue)}</td>
                      <td>{currency.format(m.cost)}</td>
                      <td className={m.profit < 0 ? "margin-negative" : ""}>{currency.format(m.profit)}</td>
                      <td className={m.marginPct < 0 ? "margin-negative" : ""}>{(m.marginPct * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {sales && (
        <>
          <h3 className="stats-section-title">Sales by item</h3>
          {salesChartData.length === 0 ? (
            <p className="report-empty">No sales in this range.</p>
          ) : (
            <>
              <SimpleBarChart data={salesChartData} valueFormatter={(v) => currency.format(v)} />
              <div className="table-panel">
                <table>
                  <thead>
                    <tr>
                      <SortableTh label="Item" active={salesSort.key === "name"} dir={salesSort.dir} onClick={() => toggleSalesSort("name")} />
                      <SortableTh label="Orders" active={salesSort.key === "orderCount"} dir={salesSort.dir} onClick={() => toggleSalesSort("orderCount")} />
                      <SortableTh label="Qty" active={salesSort.key === "totalQty"} dir={salesSort.dir} onClick={() => toggleSalesSort("totalQty")} />
                      <SortableTh label="Kg" active={salesSort.key === "totalKg"} dir={salesSort.dir} onClick={() => toggleSalesSort("totalKg")} />
                      <SortableTh label="Revenue" active={salesSort.key === "totalRevenue"} dir={salesSort.dir} onClick={() => toggleSalesSort("totalRevenue")} />
                      <th>% of revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSales.map((s) => (
                      <tr key={s.name}>
                        <td>{s.name}</td>
                        <td>{s.orderCount}</td>
                        <td>{s.totalQty || "—"}</td>
                        <td>{s.totalKg ? s.totalKg.toFixed(2) : "—"}</td>
                        <td>{currency.format(s.totalRevenue)}</td>
                        <td>{salesRevenueTotal > 0 ? `${((s.totalRevenue / salesRevenueTotal) * 100).toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {movement && (
        <>
          <h3 className="stats-section-title">Stock movement (raw intake items)</h3>
          {movement.length === 0 ? (
            <p className="report-empty">No raw-intake items configured yet.</p>
          ) : (
            <>
              {movementChartData.length > 0 && <SimpleBarChart data={movementChartData} valueFormatter={(v) => `${v.toFixed(1)} kg`} />}
              <div className="table-panel">
                <table>
                  <thead>
                    <tr>
                      <SortableTh label="Item" active={moveSort.key === "productName"} dir={moveSort.dir} onClick={() => toggleMoveSort("productName")} />
                      <SortableTh label="Pieces received" active={moveSort.key === "totalPiecesReceived"} dir={moveSort.dir} onClick={() => toggleMoveSort("totalPiecesReceived")} />
                      <SortableTh label="Kg received" active={moveSort.key === "totalKgReceived"} dir={moveSort.dir} onClick={() => toggleMoveSort("totalKgReceived")} />
                      <SortableTh label="Current on hand" active={moveSort.key === "currentOnHand"} dir={moveSort.dir} onClick={() => toggleMoveSort("currentOnHand")} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMovement.map((m) => {
                      const low = m.lowStockThreshold != null && m.currentOnHand <= m.lowStockThreshold;
                      return (
                        <tr key={m.productId}>
                          <td>{m.productName}</td>
                          <td>{m.totalPiecesReceived || "—"}</td>
                          <td>{m.totalKgReceived ? m.totalKgReceived.toFixed(2) : "—"}</td>
                          <td>{m.currentOnHand}{low && <span className="low-stock-badge">Low</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SortableTh({ label, active, dir, onClick }: { label: string; active: boolean; dir: SortDir; onClick: () => void }) {
  return (
    <th className="sortable-th" onClick={onClick}>
      {label}{active && (dir === "asc" ? " ▲" : " ▼")}
    </th>
  );
}

// Minimal horizontal bar chart — plain divs/CSS rather than a charting
// library, since the need here (rank the top N items by one number) doesn't
// warrant the extra dependency weight.
function SimpleBarChart({ data, valueFormatter }: { data: { label: string; value: number }[]; valueFormatter?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bar-chart">
      {data.map((d) => (
        <div className="bar-chart-row" key={d.label}>
          <span className="bar-chart-label">{d.label}</span>
          <div className="bar-chart-track">
            <div className="bar-chart-fill" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
          </div>
          <span className="bar-chart-value">{valueFormatter ? valueFormatter(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  );
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Same look as SimpleBarChart, plus a %-of-total next to each value — used
// for the category breakdowns (department/order type/status) on the
// Statistics overview, where "how big a slice" matters as much as the raw number.
function BreakdownBars({ items, valueFormatter }: { items: { label: string; value: number }[]; valueFormatter: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((sum, i) => sum + i.value, 0);
  if (items.length === 0 || total === 0) return <p className="report-empty">No data in this range.</p>;
  return (
    <div className="bar-chart">
      {items.map((i) => (
        <div className="bar-chart-row" key={i.label}>
          <span className="bar-chart-label">{i.label}</span>
          <div className="bar-chart-track">
            <div className="bar-chart-fill" style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </div>
          <span className="bar-chart-value">{valueFormatter(i.value)} <span className="bar-chart-pct">({((i.value / total) * 100).toFixed(1)}%)</span></span>
        </div>
      ))}
    </div>
  );
}

// A single headline KPI with a %-change chip vs. the immediately preceding
// period of equal length (server-computed — see statisticsOverview). A null
// prevValue (kg sold has no meaningful "previous" comparison shown) just
// omits the chip; a zero previous value with a nonzero current one shows
// "New" rather than a meaningless (or infinite) percentage.
function KpiCard({ label, value, prevValue, formatter }: { label: string; value: number; prevValue: number | null; formatter: (v: number) => string }) {
  let chip: { text: string; dir: "up" | "down" | "flat" } | null = null;
  if (prevValue != null) {
    if (prevValue === 0) {
      chip = value === 0 ? null : { text: "New", dir: "up" };
    } else {
      const pct = ((value - prevValue) / Math.abs(prevValue)) * 100;
      chip = { text: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`, dir: Math.abs(pct) < 0.05 ? "flat" : pct > 0 ? "up" : "down" };
    }
  }
  const Icon = chip?.dir === "up" ? ArrowUp : chip?.dir === "down" ? ArrowDown : Minus;
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{formatter(value)}</div>
      {chip && (
        <div className={`kpi-chip kpi-chip-${chip.dir}`}>
          <Icon size={13} /> {chip.text} <span className="kpi-chip-sub">vs previous period</span>
        </div>
      )}
    </div>
  );
}

// SVG line/area chart for revenue-by-day, with a hover crosshair + tooltip
// (date, revenue, order count) — the one series here doesn't need a legend,
// its axis/title already name it.
function RevenueTrendChart({ data }: { data: { date: string; revenue: number; orders: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 760, height = 220, padL = 8, padR = 8, padT = 16, padB = 24;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const n = data.length;
  const maxVal = Math.max(1, ...data.map((d) => d.revenue));
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / maxVal) * innerH;
  const linePoints = data.map((d, i) => `${x(i)},${y(d.revenue)}`).join(" ");
  const areaPoints = `${x(0)},${padT + innerH} ${linePoints} ${x(n - 1)},${padT + innerH}`;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let closest = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px);
      if (d < best) { best = d; closest = i; }
    }
    setHoverIdx(closest);
  };

  const hovered = hoverIdx != null ? data[hoverIdx] : null;

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="trend-chart-svg"
        onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        <line x1={padL} y1={padT + innerH} x2={width - padR} y2={padT + innerH} className="trend-chart-axis" />
        <polygon points={areaPoints} className="trend-chart-area" />
        <polyline points={linePoints} className="trend-chart-line" />
        {hovered && hoverIdx != null && (
          <>
            <line x1={x(hoverIdx)} y1={padT} x2={x(hoverIdx)} y2={padT + innerH} className="trend-chart-crosshair" />
            <circle cx={x(hoverIdx)} cy={y(hovered.revenue)} r={4} className="trend-chart-dot" />
          </>
        )}
      </svg>
      {hovered && hoverIdx != null && (
        <div
          className="trend-chart-tooltip"
          style={{ left: `${(x(hoverIdx) / width) * 100}%` }}
        >
          <div className="trend-chart-tooltip-date">{new Date(`${hovered.date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</div>
          <div>{currency.format(hovered.revenue)}</div>
          <div className="trend-chart-tooltip-sub">{hovered.orders} order{hovered.orders === 1 ? "" : "s"}</div>
        </div>
      )}
      <div className="trend-chart-labels">
        <span>{new Date(`${data[0].date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</span>
        <span>{new Date(`${data[n - 1].date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

// Same shape as RevenueTrendChart but plots marginPct (0-1) rather than a
// rand figure — so nemench can see whether margins are drifting over time
// (e.g. supplier costs rising without sell prices following), not just
// today's snapshot number.
function MarginTrendChart({ data }: { data: { date: string; marginPct: number; revenue: number; profit: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 760, height = 220, padL = 8, padR = 8, padT = 16, padB = 24;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const n = data.length;
  const maxVal = Math.max(0.05, ...data.map((d) => d.marginPct));
  const minVal = Math.min(0, ...data.map((d) => d.marginPct));
  const range = maxVal - minVal || 1;
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - minVal) / range) * innerH;
  const linePoints = data.map((d, i) => `${x(i)},${y(d.marginPct)}`).join(" ");
  const zeroY = y(Math.max(minVal, 0));
  const areaPoints = `${x(0)},${zeroY} ${linePoints} ${x(n - 1)},${zeroY}`;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let closest = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px);
      if (d < best) { best = d; closest = i; }
    }
    setHoverIdx(closest);
  };

  const hovered = hoverIdx != null ? data[hoverIdx] : null;

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="trend-chart-svg"
        onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        <line x1={padL} y1={zeroY} x2={width - padR} y2={zeroY} className="trend-chart-axis" />
        <polygon points={areaPoints} className="trend-chart-area" />
        <polyline points={linePoints} className="trend-chart-line" />
        {hovered && hoverIdx != null && (
          <>
            <line x1={x(hoverIdx)} y1={padT} x2={x(hoverIdx)} y2={padT + innerH} className="trend-chart-crosshair" />
            <circle cx={x(hoverIdx)} cy={y(hovered.marginPct)} r={4} className="trend-chart-dot" />
          </>
        )}
      </svg>
      {hovered && hoverIdx != null && (
        <div className="trend-chart-tooltip" style={{ left: `${(x(hoverIdx) / width) * 100}%` }}>
          <div className="trend-chart-tooltip-date">{new Date(`${hovered.date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</div>
          <div>{(hovered.marginPct * 100).toFixed(1)}% margin</div>
          <div className="trend-chart-tooltip-sub">{currency.format(hovered.profit)} profit</div>
        </div>
      )}
      <div className="trend-chart-labels">
        <span>{new Date(`${data[0].date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</span>
        <span>{new Date(`${data[n - 1].date}T00:00:00`).toLocaleDateString(appSettings.locale, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

// Headline weighted-average margin for the period, with a percentage-point
// (not relative-%) change vs. the previous equivalent period — "margin
// went from 30% to 35%" should read as "+5pp," not the more confusing
// "+16.7%" a relative-change calculation would produce for the same move.
function MarginSummaryCard({ current, previous }: { current: number; previous: number }) {
  const deltaPp = (current - previous) * 100;
  const dir: "up" | "down" | "flat" = Math.abs(deltaPp) < 0.05 ? "flat" : deltaPp > 0 ? "up" : "down";
  const Icon = dir === "up" ? ArrowUp : dir === "down" ? ArrowDown : Minus;
  return (
    <div className="kpi-card">
      <div className="kpi-label">Average margin this period</div>
      <div className="kpi-value">{(current * 100).toFixed(1)}%</div>
      <div className={`kpi-chip kpi-chip-${dir}`}>
        <Icon size={13} /> {deltaPp > 0 ? "+" : ""}{deltaPp.toFixed(1)}pp <span className="kpi-chip-sub">vs previous period</span>
      </div>
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
// (80mm, for receipt printers) or A4 (full-page) layout. `forEmail`
// narrows the layout to a fixed max-width (email clients have no concept
// of "A4 page", so the unconstrained A4 body would otherwise render as
// full-viewport-wide in a reading pane) — only ever passed by
// EmailReceiptModal, never by the print path.
function buildReceiptHtml(order: Order, type: "kitchen" | "counter" | "master", style: "thermal" | "a4", forEmail = false): string {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  const d = new Date(order.createdAt);
  const dateStr = d.toLocaleDateString(appSettings.locale);
  const timeStr = d.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" });
  // Print: a data URI (works offline, no server round trip needed to render
  // the preview). Email: a real URL against the configured public base URL
  // - a data URI would just get stripped by the recipient's mail client
  // (see the receiptBranding comment above) - or no image at all if no
  // public base URL has been configured, rather than a link that's
  // guaranteed unreachable.
  const logoUrl = forEmail
    ? (receiptBranding.publicBaseUrl ? `${receiptBranding.publicBaseUrl}${receiptBranding.logoUrl || "/logo.jpg"}` : "")
    : (logoDataUri ?? assetUrl(receiptBranding.logoUrl || "/logo.jpg"));
  const siteName = esc(receiptBranding.siteName || "NemenchPos");
  const { blue, blueDark } = deriveShades(/^#[0-9a-f]{6}$/i.test(receiptBranding.themeColor) ? receiptBranding.themeColor : "#1a47a0");
  // CODE128, not EAN13 — the ticket number ("20260712-002") has a dash and
  // isn't 13 digits, so it can't be an EAN13. Scanning it (Queue/History's
  // "Scan order" button, or POS's "Scan to reorder") looks the order back
  // up by this exact ticketNumber (see api.orders.getByTicket) — no data
  // beyond the ticket number itself is encoded; that's a deliberate choice
  // over trying to cram per-item data into a 1D barcode's limited capacity,
  // see server/routes/orders.ts's by-ticket route comment for why.
  // displayValue:false since the ticket number is already shown as text
  // right next to it — repeating it under the barcode would be redundant.
  const ticketBarcodeSvg = renderBarcodeSvgMarkup(order.ticketNumber, "CODE128", { height: 28, margin: 0, displayValue: false });
  // Order Consolidation feature: an EAN-13, distinct prefix from both the
  // ticket CODE128 above and every per-product barcode (see
  // orderConsolidationBarcode.ts) — only present once every line item has
  // been scanned and verified (server/database.ts's finalizeConsolidation),
  // so most receipts never show this block at all. displayValue:true here
  // (unlike the ticket barcode) since this is the definitive "verified
  // complete" record staff/customer may want to read the digits off of.
  const consolidationBarcodeSvg = order.consolidationBarcode && !forEmail
    ? renderBarcodeSvgMarkup(order.consolidationBarcode, "EAN13", { height: 45, margin: 4, displayValue: true })
    : "";

  // Only the customer-facing "master" receipt is a financial document —
  // kitchen/counter slips are prep instructions, so they keep the
  // plain KITCHEN/COUNTER ORDER label and never show prices/VAT/totals.
  const isReceipt = type === "master";
  const subtotal = items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);
  const discountAmount = isReceipt ? Math.min(Math.max(0, order.discountAmount || 0), subtotal) : 0;
  const totalDue = subtotal - discountAmount;
  // SARS: prices are VAT-inclusive by law, so VAT here is the tax
  // component already inside the total, not an amount added on top —
  // and it's only shown at all if the business is actually VAT-registered.
  const vatAmount = isReceipt && receiptBranding.vatRegistered ? totalDue * (0.15 / 1.15) : 0;
  // Abridged tax invoice (till slip) is fine up to R5000; a full tax
  // invoice (this one, since the >R5000 POS flow captures buyer details)
  // is required above that — see SARS Tax Invoice Guide.
  const isFullTaxInvoice = isReceipt && receiptBranding.vatRegistered && totalDue > 5000;
  const label = type === "kitchen" ? "KITCHEN ORDER" : type === "counter" ? "COUNTER ORDER"
    : receiptBranding.vatRegistered ? "TAX INVOICE" : "RECEIPT";

  // A plain payment record (cash/card), not a payment integration — this
  // app never touches card data, so "Card" just means "paid by card
  // elsewhere" for reconciliation purposes.
  const paymentLine = isReceipt
    ? order.paymentMethod === "cash"
      ? `Paid: Cash - Tendered ${currency.format(order.cashTendered ?? totalDue)}, Change ${currency.format(Math.max(0, (order.cashTendered ?? totalDue) - totalDue))}`
      : "Paid: Card"
    : "";

  // Shown whenever an address was actually captured — not gated to
  // orderType === "delivery", since a >R5000 POS sale also stores the
  // buyer's address (SARS full tax invoice requirement) on an otherwise
  // ordinary "pickup" order.
  const addrLines = order.deliveryAddress?.street
    ? [order.deliveryAddress.street, order.deliveryAddress.area, order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `Apt ${order.deliveryAddress.apartment}` : ""].filter(Boolean)
    : [];
  const requestedAtLine = order.requestedTime ? `${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${formatRequestedTime(order.requestedTime)}` : "";

  if (style === "a4") {
    const rows = items.map((i) => `<tr>
      <td><b>${esc(i.name)}</b>${i.notes ? `<div class="note">${esc(i.notes)}</div>` : ""}</td>
      <td>${i.kg ? `${i.kg} kg` : i.wantedPrice ? `${currency.format(i.wantedPrice)} (to weigh)` : "—"}</td>
      <td>${i.quantity ? `×${i.quantity}` : "—"}</td>
      ${isReceipt ? `<td>${i.lineTotal != null ? currency.format(i.lineTotal) : "—"}</td>` : ""}
    </tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} — ${esc(order.ticketNumber)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e;line-height:1.5;padding:18mm}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid ${blueDark};margin-bottom:20px}
.hdr-left .shop{font-size:20px;font-weight:800;color:${blue}}.hdr-left .type{font-size:15px;font-weight:700;color:${blueDark};margin-top:4px}
.hdr-left .legal{font-size:11px;color:#666;margin-top:6px;line-height:1.4}
.hdr-right{text-align:right}.logo{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid ${blueDark}}
.tnum{font-size:14px;font-weight:700;color:${blueDark};margin-top:6px}.dt{font-size:12px;color:#666;margin-top:2px}
.tbarcode{margin-top:4px}.tbarcode svg{height:22px}
.cbox{border:1px solid #c8d5ee;border-radius:8px;padding:14px 18px;margin-bottom:20px;background:#f4f7fd}
.clbl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6480;font-weight:700;margin-bottom:8px}
.cname{font-size:16px;font-weight:700;color:${blueDark}}.cline{font-size:13px;color:#333;margin-top:4px}
.del{color:${blue};font-weight:700}.ttag{color:${blueDark};font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:8px}thead tr{background:${blueDark}}
th{color:#fff;padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
td{padding:9px 12px;border-bottom:1px solid #e8eef7;font-size:13px;vertical-align:top}
tr:nth-child(even) td{background:#f8f9fc}tr:last-child td{border-bottom:none}
.note{font-size:11px;color:#666;margin-top:2px}
.totals{margin-left:auto;width:280px;margin-top:4px;border-collapse:collapse}
.totals td{padding:4px 0;font-size:13px;color:#444;border:none}
.totals td:last-child{text-align:right}
.totals .grand td{font-size:17px;font-weight:800;color:#1a1a2e;border-top:2px solid ${blueDark};padding-top:8px}
.footer{margin-top:40px;text-align:center;color:#888;font-size:12px;border-top:1px solid #e0e6f0;padding-top:12px}
.consolidated{margin-top:16px;padding:12px;border:2px solid ${blueDark};border-radius:8px;text-align:center}
.consolidated .clbl{color:${blueDark}}
</style></head><body>
${forEmail ? '<div style="max-width:480px;margin:0 auto;padding:16px;box-sizing:border-box;">' : ""}
<div class="hdr">
  <div class="hdr-left">
    <div class="shop">${siteName}</div>
    <div class="type">${esc(label)}${isFullTaxInvoice ? " (Full)" : ""}</div>
    ${isReceipt && (receiptBranding.businessAddress || (receiptBranding.vatRegistered && receiptBranding.vatNumber)) ? `<div class="legal">
      ${receiptBranding.businessAddress ? esc(receiptBranding.businessAddress).replace(/\n/g, "<br>") + "<br>" : ""}
      ${receiptBranding.vatRegistered && receiptBranding.vatNumber ? `VAT Reg. No: ${esc(receiptBranding.vatNumber)}` : ""}
    </div>` : ""}
  </div>
  <div class="hdr-right">${logoUrl ? `<img class="logo" src="${logoUrl}" alt="${siteName}">` : ""}<div class="tnum">${esc(order.ticketNumber)}</div><div class="dt">${dateStr} &nbsp; ${timeStr}</div>${forEmail ? "" : `<div class="tbarcode">${ticketBarcodeSvg}</div>`}</div>
</div>
${order.customerName ? `<div class="cbox">
  <div class="clbl">Customer Details</div>
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cline">${esc(order.customerPhone)}</div>
  <div class="cline ${order.orderType === "delivery" ? "del" : ""}">${order.orderType === "delivery" ? "★ DELIVERY" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="cline">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="cline ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="cline">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="cline">Assigned to: <b>${esc(order.assignedTo)}</b></div>` : ""}
</div>` : ""}
<table><thead><tr><th>Item</th><th>Kg</th><th>Qty</th>${isReceipt ? "<th>Price</th>" : ""}</tr></thead>
<tbody>${rows}</tbody></table>
${isReceipt ? `<table class="totals"><tbody>
  <tr><td>Subtotal</td><td>${currency.format(subtotal)}</td></tr>
  ${discountAmount > 0 ? `<tr><td>Discount</td><td>-${currency.format(discountAmount)}</td></tr>` : ""}
  ${receiptBranding.vatRegistered ? `<tr><td>VAT incl. (15%)</td><td>${currency.format(vatAmount)}</td></tr>` : ""}
  <tr class="grand"><td>Total</td><td>${currency.format(totalDue)}</td></tr>
  ${paymentLine ? `<tr><td colspan="2">${esc(paymentLine)}</td></tr>` : ""}
</tbody></table>` : ""}
${consolidationBarcodeSvg ? `<div class="consolidated"><div class="clbl">Order Verified &amp; Consolidated</div>${consolidationBarcodeSvg}</div>` : ""}
<div class="footer">Thank you for your order - ${siteName}</div>
${forEmail ? "</div>" : ""}
</body></html>`;
  }

  // Thermal (80mm)
  const rows = items.map((i) => {
    const qty = [i.kg ? `${i.kg} kg` : i.wantedPrice ? `${currency.format(i.wantedPrice)} (to weigh)` : "", i.quantity ? `×${i.quantity}` : ""].filter(Boolean).join("  ");
    const priceLine = isReceipt && i.lineTotal != null ? `<div class="iprice">${currency.format(i.lineTotal)}</div>` : "";
    return `<div class="item"><div class="iname">${esc(i.name)}</div><div class="isub">${esc(qty)}${i.notes ? `  - ${esc(i.notes)}` : ""}</div>${priceLine}</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} — ${esc(order.ticketNumber)}</title><style>
@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',Courier,monospace;font-size:12px;width:72mm;padding:4mm;margin:0 auto;line-height:1.5;color:#000}
.center{text-align:center}.sep{border:none;border-top:1px dashed #999;margin:6px 0}
.logo{width:52px;height:52px;border-radius:50%;object-fit:cover;margin-bottom:4px}
.shop{font-size:13px;font-weight:bold;color:${blue};letter-spacing:.5px}
.lbl{font-size:15px;font-weight:bold;letter-spacing:1px;color:${blueDark};margin-top:2px}
.legal{font-size:10px;color:#444;margin-top:2px;line-height:1.4}
.tnum{font-size:12px;font-weight:bold;color:#333}.dt{font-size:11px;color:#555}
.cust{margin:4px 0}.cname{font-size:13px;font-weight:bold}
.cphone{font-size:12px;color:#333}.del{font-weight:bold;color:${blue}}
.addr{font-size:11px;color:#333;margin-top:2px}.ttag{font-size:11px;font-weight:bold;color:${blueDark};margin-top:2px}
.by{font-size:10px;color:#666;margin-top:2px}
.item{margin:5px 0}.iname{font-weight:bold}.isub{color:#444;font-size:11px;margin-top:1px}
.iprice{text-align:right;font-weight:bold;font-size:12px;margin-top:1px}
.totals{width:100%;border-collapse:collapse;margin:2px 0}
.totals td{font-size:12px;padding:1px 0}
.totals td:last-child{text-align:right}
.totals .grand td{font-size:15px;font-weight:bold;border-top:1px solid #000;padding-top:4px}
.footer{font-size:11px;color:#555}
.tbarcode{margin-top:2mm}.tbarcode svg{height:20px;max-width:100%}
.consolidated{margin-top:3mm;padding:2mm;border:1px solid #000}
.consolidated .clbl{font-size:10px;font-weight:bold}
</style></head><body>
${forEmail ? '<div style="max-width:380px;margin:0 auto;padding:16px;box-sizing:border-box;">' : ""}
<div class="center">
  ${logoUrl ? `<img class="logo" src="${logoUrl}" alt="${siteName}">` : ""}
  <div class="shop">${siteName}</div>
  <div class="lbl">${esc(label)}${isFullTaxInvoice ? " (Full)" : ""}</div>
  ${isReceipt && (receiptBranding.businessAddress || (receiptBranding.vatRegistered && receiptBranding.vatNumber)) ? `<div class="legal">
    ${receiptBranding.businessAddress ? esc(receiptBranding.businessAddress).replace(/\n/g, "<br>") + "<br>" : ""}
    ${receiptBranding.vatRegistered && receiptBranding.vatNumber ? `VAT Reg: ${esc(receiptBranding.vatNumber)}` : ""}
  </div>` : ""}
  <div class="tnum">${esc(order.ticketNumber)}</div>
  <div class="dt">${dateStr} &nbsp; ${timeStr}</div>
  ${forEmail ? "" : `<div class="tbarcode">${ticketBarcodeSvg}</div>`}
</div>
<hr class="sep">
${order.customerName ? `<div class="cust">
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cphone">${esc(order.customerPhone)}</div>
  <div class="${order.orderType === "delivery" ? "del" : "cphone"}">${order.orderType === "delivery" ? "*** DELIVERY ***" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="addr">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="by">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="by">Assigned to: <b>${esc(order.assignedTo)}</b></div>` : ""}
</div>
<hr class="sep">` : ""}
${rows}
<hr class="sep">
${isReceipt ? `
<table class="totals"><tbody>
<tr><td>Subtotal</td><td>${currency.format(subtotal)}</td></tr>
${discountAmount > 0 ? `<tr><td>Discount</td><td>-${currency.format(discountAmount)}</td></tr>` : ""}
${receiptBranding.vatRegistered ? `<tr><td>VAT incl. (15%)</td><td>${currency.format(vatAmount)}</td></tr>` : ""}
<tr class="grand"><td>Total</td><td>${currency.format(totalDue)}</td></tr>
</tbody></table>
${paymentLine ? `<div class="center" style="font-size:11px;margin-top:4px">${esc(paymentLine)}</div>` : ""}
<hr class="sep">` : ""}
${consolidationBarcodeSvg ? `<div class="consolidated center"><div class="clbl">ORDER VERIFIED &amp; CONSOLIDATED</div>${consolidationBarcodeSvg}</div>` : ""}
<div class="center footer">Thank you for your order</div>
${forEmail ? "</div>" : ""}
</body></html>`;
}

// Escapes user-supplied text before interpolating into the HTML strings
// built throughout this file — every dynamic value in a receipt/summary
// goes through this to prevent a customer/product/supplier name from
// breaking the markup (or injecting script into the print window).
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Builds the printable weigh-in batch summary: one page per supplier+product
// combination (showing every individual line plus a per-item subtotal, and the
// supplier's grand total on its last product's page), then a final grand-total
// page across all suppliers. `heading` is overridden to "... — PREVIEW" when
// called from the non-finalizing preview button, so the printout is visually
// distinguishable from a real one.
function buildWeighInSummaryHtml(dateIso: string, lines: WeighInLine[], products: Product[], heading = "WEIGH-IN SUMMARY"): string {
  const siteName = esc(receiptBranding.siteName || "NemenchPos");
  const logoUrl = logoDataUri ?? assetUrl(receiptBranding.logoUrl || "/logo.jpg");
  const { blue, blueDark } = deriveShades(/^#[0-9a-f]{6}$/i.test(receiptBranding.themeColor) ? receiptBranding.themeColor : "#1a47a0");
  const d = new Date(dateIso);
  const dateStr = d.toLocaleString(appSettings.locale, { dateStyle: "medium", timeStyle: "short" });

  const productName = (id: number) => products.find((p) => p.id === id)?.name ?? "—";

  // Section by supplier; within each supplier, group by item — each item gets its own
  // printed page showing its individual weigh-in lines plus a per-item subtotal, and the
  // supplier's grand total is appended to that supplier's final item page
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
      const sortedItems = [...items.values()].sort((a, b) => a.productName.localeCompare(b.productName));
      const subPieces = supplier.lines.reduce((sum, l) => sum + l.piecesReceived, 0);
      const subKg = supplier.lines.reduce((sum, l) => sum + l.weightKg, 0);
      return sortedItems
        .map((it, idx) => {
          const lineRows = [...it.lines]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((l) => `<tr><td></td><td>${esc(l.grade)}</td><td>${l.piecesReceived}</td><td>${l.weightKg.toFixed(2)}</td></tr>`)
            .join("");
          const itPieces = it.lines.reduce((sum, l) => sum + l.piecesReceived, 0);
          const itKg = it.lines.reduce((sum, l) => sum + l.weightKg, 0);
          const supplierTotalRow = idx === sortedItems.length - 1
            ? `<tr class="totals"><td colspan="2">Supplier total</td><td>${subPieces}</td><td>${subKg.toFixed(2)}</td></tr>`
            : "";
          return `<div class="weigh-page">
<h3 class="supplier-hdr">${esc(supplier.name)}</h3>
<table><thead><tr><th>Item</th><th>Grade</th><th>Pieces</th><th>Kg</th></tr></thead>
<tbody>
<tr class="item-hdr"><td colspan="4">${esc(it.productName)}</td></tr>${lineRows}
<tr class="item-subtotal"><td colspan="2">${esc(it.productName)} subtotal</td><td>${itPieces}</td><td>${itKg.toFixed(2)}</td></tr>
${supplierTotalRow}
</tbody></table>
</div>`;
        })
        .join("");
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
.weigh-page{page-break-inside:avoid}.weigh-page+.weigh-page{page-break-before:always}
</style></head><body>
<div class="hdr">
  <div class="hdr-left"><div class="shop">${siteName}</div><div class="type">${esc(heading)}</div></div>
  <div class="hdr-right"><img class="logo" src="${logoUrl}" alt="${siteName}"><div class="dt">${dateStr}</div></div>
</div>
${supplierSections}
<div class="weigh-page">
<h2 class="section-hdr">Item totals — all suppliers</h2>
<table><thead><tr><th>Item</th><th>Pieces</th><th>Kg</th></tr></thead>
<tbody>${itemTotalRows}
<tr class="totals"><td>Grand total</td><td>${grandPieces}</td><td>${grandKg.toFixed(2)}</td></tr>
</tbody></table>
</div>
</body></html>`;
}

// Renders a barcode to a standalone SVG markup string (rather than into a
// React-owned <svg>) so it can be embedded in the standalone sticker
// document below — JsBarcode draws into a real DOM element regardless, so
// a detached one is created, drawn into, then serialized and discarded.
function renderBarcodeSvgMarkup(value: string, format: "EAN13" | "CODE128" = "EAN13", opts: { height?: number; margin?: number; displayValue?: boolean } = {}): string {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(svg, value, { format, displayValue: opts.displayValue ?? true, height: opts.height ?? 60, margin: opts.margin ?? 8 });
  return new XMLSerializer().serializeToString(svg);
}

// Common small-label sizes this app can print a sticker at — "50x30" is
// the original fixed size this feature launched with; the other two match
// popular thermal-label-roll dimensions so a shop isn't stuck buying one
// specific label stock just for this app.
const LABEL_SIZES = {
  "50x30": { widthMm: 50, heightMm: 30, nameMax: 24, svgMax: 16 },
  "40x30": { widthMm: 40, heightMm: 30, nameMax: 24, svgMax: 14 },
  "38x25": { widthMm: 38, heightMm: 25, nameMax: 18, svgMax: 11 }
} as const;
export type LabelSize = keyof typeof LABEL_SIZES;

export interface LabelPrefs {
  size: LabelSize;
  copies: number;
  showPrice: boolean;
  showCategory: boolean;
  showCost: boolean;
}

// A small printable sticker — barcode plus whichever fields prefs asks
// for — reusing the same printHtml()/api.print() pipe as receipts and KOT
// tickets (see printReceipt) rather than a separate print mechanism, so it
// goes to whatever printer is already configured. `copies` repeats the
// same label on successive forced page-breaks — correct for a
// continuous-roll label printer (each page break advances one physical
// label) and equally fine on a sheet printer (one label per page).
function buildBarcodeStickerHtml(product: { name: string; category: string; barcode: string; pricePerUnit: number | null; costPerUnit: number | null }, prefs: LabelPrefs): string {
  const { widthMm, heightMm, nameMax, svgMax } = LABEL_SIZES[prefs.size];
  const barcodeSvg = renderBarcodeSvgMarkup(product.barcode);
  const label = `
<div class="name">${esc(product.name)}</div>
${prefs.showCategory && product.category ? `<div class="meta">${esc(product.category)}</div>` : ""}
${prefs.showPrice && product.pricePerUnit != null ? `<div class="price">${currency.format(product.pricePerUnit)}/kg</div>` : ""}
${prefs.showCost && product.costPerUnit != null ? `<div class="meta">Cost: ${currency.format(product.costPerUnit)}/kg</div>` : ""}
${barcodeSvg}`;
  const copies = Math.min(Math.max(1, Math.round(prefs.copies) || 1), 200);
  const pages = Array.from({ length: copies }, (_, i) => `<div class="label"${i > 0 ? ' style="page-break-before:always"' : ""}>${label}</div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sticker — ${esc(product.barcode)}</title><style>
@page{size:${widthMm}mm ${heightMm}mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,Arial,sans-serif}
.label{width:${widthMm}mm;height:${heightMm}mm;padding:2mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.name{font-size:10px;font-weight:700;line-height:1.2;max-height:${nameMax}px;overflow:hidden}
.meta{font-size:8px;color:#444;margin-top:0.5mm}
.price{font-size:11px;font-weight:800;margin-top:1mm}
svg{width:100%;max-height:${svgMax}mm}
</style></head><body>${pages}</body></html>`;
}

// ── Print Labels (DB-driven format presets) ──────────────────────────────────
// Distinct from buildBarcodeStickerHtml/LabelPrefs above (the Stock panel's
// quick single-sticker reprint, fixed to 3 hardcoded sizes) — this is the
// fuller "Print Labels" tab: DB-configurable formats (thermal AND A4 sheet
// grids), a weighed-price field, and a live on-screen preview (rendered by
// PrintLabelsPanel, below) that reuses this exact HTML rather than a
// parallel React re-implementation that could drift from what actually prints.

const LABEL_CELL_STYLE = `
.label{box-sizing:border-box;padding:1.5mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;font-family:Inter,Arial,sans-serif}
.lname{font-size:9px;font-weight:700;line-height:1.15;max-height:22px;overflow:hidden}
.lweight{font-size:7px;color:#444;margin-top:0.3mm}
.lprice{font-size:11px;font-weight:800;margin-top:0.5mm}
.label svg{width:100%;max-height:40%}`;

// The visual content of ONE label — shared by the thermal renderer (one
// per page), the A4 grid renderer (one per cell), and the live preview's
// zoomed single-label view, so all three can never visually disagree.
function buildLabelCellHtml(data: LabelData, widthMm: number, heightMm: number): string {
  // unitDefault === "qty" is fixed-unit/each; "kg" and "kg_qty" are both
  // weight-priced — same distinction POS's own product tiles already use.
  const isWeighed = data.unitDefault !== "qty";
  // A weighed item's label shows the actual price for THIS portion (rate
  // x entered weight) — what a real deli label shows a customer — not
  // just the per-kg rate. Falls back to the plain rate if no weight has
  // been entered yet (e.g. while the staff member is still filling in the form).
  const computedPrice = data.pricePerUnit != null && data.weightKg != null ? data.pricePerUnit * data.weightKg : null;
  const priceLine = isWeighed
    ? (computedPrice != null ? currency.format(computedPrice) : data.pricePerUnit != null ? `${currency.format(data.pricePerUnit)}/kg` : "")
    : (data.pricePerUnit != null ? currency.format(data.pricePerUnit) : "");
  const weightLine = isWeighed && data.weightKg != null && data.pricePerUnit != null ? `${data.weightKg.toFixed(3)} kg @ ${currency.format(data.pricePerUnit)}/kg` : "";

  // A weighed product has no single static barcode to render (see
  // weighBarcode.ts) — its label needs a FRESH one built from its stable
  // itemCode plus THIS portion's actual price, every time. Naively
  // rendering a 5-digit itemCode (or an absent/irrelevant `barcode`) as
  // an "EAN13" used to crash JsBarcode outright, taking down the whole
  // label print/preview for any weighed product. No barcode is shown at
  // all until a weight has actually been entered — there's no real price
  // to encode before then, and showing a stale/zero one would be wrong.
  let barcodeSvg = "";
  if (isWeighed) {
    if (data.itemCode && computedPrice != null) {
      try {
        barcodeSvg = renderBarcodeSvgMarkup(buildWeighBarcode(data.itemCode, computedPrice), "EAN13", { height: Math.max(10, heightMm * 0.5), margin: 0, displayValue: true });
      } catch { /* price out of the 0-999.99 range buildWeighBarcode accepts — leave blank rather than crash the label */ }
    }
  } else if (data.barcode) {
    barcodeSvg = renderBarcodeSvgMarkup(data.barcode, "EAN13", { height: Math.max(10, heightMm * 0.5), margin: 0, displayValue: true });
  }

  return `<div class="label" style="width:${widthMm}mm;height:${heightMm}mm">
    <div class="lname">${esc(data.name)}</div>
    ${weightLine ? `<div class="lweight">${esc(weightLine)}</div>` : ""}
    ${priceLine ? `<div class="lprice">${esc(priceLine)}</div>` : ""}
    ${barcodeSvg || (isWeighed ? `<div class="lweight">${data.itemCode ? "Enter weight to generate barcode" : "No item code set"}</div>` : "")}
  </div>`;
}

// Thermal: one label per physical print, each entry in `items` (already
// expanded to one row per copy — see flattenBatch) on its own forced
// page-break — correct for a continuous roll (each break advances one
// label) and equally fine on a cut-sheet printer. Different products can
// be mixed in one run (a batch print job isn't restricted to one product
// at a time) since each item carries its own label data.
function buildThermalPrintHtml(items: LabelData[], format: LabelFormat): string {
  const capped = items.slice(0, 2000);
  if (capped.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>`;
  }
  const pages = capped.map((data, i) => {
    const cell = buildLabelCellHtml(data, format.widthMm, format.heightMm);
    return i === 0 ? cell : `<div style="page-break-before:always">${cell}</div>`;
  }).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Labels (${capped.length})</title><style>
@page{size:${format.widthMm}mm ${format.heightMm}mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;color:#000}
${LABEL_CELL_STYLE}
</style></head><body>${pages}</body></html>`;
}

// A4/Letter sheet: labels fill a fixed rows x cols grid per page, in
// reading order (left-to-right, top-to-bottom), pulling from `items` in
// order — a mixed-product batch prints as one continuous stream across
// however many sheets it takes, not restricted to one product per sheet.
// `blockedPositions` (1-based cell numbers, reading order) marks cells
// already peeled off a physical sheet — those are skipped on the FIRST
// sheet only (see placeOnSheets), so a partially-used sheet can be reused
// for exactly its remaining gaps. The physical page itself defaults to
// A4 portrait (210x297mm) unless the format specifies otherwise (US
// Letter, or an A4 sheet used in landscape — see LabelFormat's schema
// comment in shared/types.ts).
function buildA4SheetHtml(items: LabelData[], format: LabelFormat, blockedPositions: ReadonlySet<number>): string {
  if (format.type !== "a4_sheet" || !format.sheetCols || !format.sheetRows) {
    throw new Error("buildA4SheetHtml requires an a4_sheet format with sheetCols/sheetRows set");
  }
  const perSheet = format.sheetCols * format.sheetRows;
  const sheets = placeOnSheets(items.slice(0, 5000), perSheet, blockedPositions);
  const gapX = format.gapXMm ?? 0;
  const gapY = format.gapYMm ?? 0;
  const pageW = format.pageWidthMm ?? 210;
  const pageH = format.pageHeightMm ?? 297;

  const pages = sheets.map((sheet, s) => {
    const cells = sheet.map((data) => data ? buildLabelCellHtml(data, format.widthMm, format.heightMm) : `<div class="label-empty"></div>`).join("");
    return `<div class="sheet"${s > 0 ? ' style="page-break-before:always"' : ""}>${cells}</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Labels (${items.length})</title><style>
@page{size:${pageW}mm ${pageH}mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;color:#000}
.sheet{width:${pageW}mm;height:${pageH}mm;padding:${format.marginTopMm ?? 0}mm 0 0 ${format.marginLeftMm ?? 0}mm;display:grid;grid-template-columns:repeat(${format.sheetCols},${format.widthMm}mm);grid-template-rows:repeat(${format.sheetRows},${format.heightMm}mm);column-gap:${gapX}mm;row-gap:${gapY}mm}
.label-empty{width:${format.widthMm}mm;height:${format.heightMm}mm}
${LABEL_CELL_STYLE}
</style></head><body>${pages}</body></html>`;
}

// The sheet preview used to size its iframe by CSS alone (max-width:420px
// on the wrapper) while the iframe's *content* was the real, physically-
// sized page HTML — a browser doesn't shrink an iframe's content to fit a
// small frame, so in practice most of the sheet was just clipped off
// rather than "previewed". Fixing that means actually rendering the
// iframe at true page size (whatever page size THIS format actually
// uses — A4, Letter, or landscape) and scaling the whole thing down with
// a CSS transform, recomputed on resize so it always exactly fills
// whatever width the panel gives it.
//
// `children` (see SheetPositionPicker) is rendered into a second element
// stacked exactly on top of the iframe, sized and scaled identically —
// same px dimensions, same transform — so any mm-based CSS grid inside
// it lines up cell-for-cell with the iframe's own `.sheet` grid without
// needing to duplicate the scale math. That's what makes the position-
// picker/alignment-grid a true overlay on the real preview rather than a
// separate grid rendered below it.
function ScaledSheetFrame({ srcDoc, pageWidthMm, pageHeightMm, children }: { srcDoc: string; pageWidthMm: number; pageHeightMm: number; children?: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // CSS reference pixels (1mm = 96/25.4px, the same fixed ratio the
  // browser itself uses to lay out "mm" units), so this is exact
  // regardless of the viewer's actual screen DPI.
  const pxW = (pageWidthMm * 96) / 25.4;
  const pxH = (pageHeightMm * 96) / 25.4;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth > 0 ? el.clientWidth / pxW : 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pxW]);

  const scaledBoxStyle = { width: `${pxW}px`, height: `${pxH}px`, transform: `scale(${scale})` };

  return (
    <div ref={wrapRef} className="label-preview-frame label-preview-frame-a4" style={{ aspectRatio: `${pageWidthMm} / ${pageHeightMm}` }}>
      <iframe title="Sheet preview" srcDoc={srcDoc} style={scaledBoxStyle} />
      {children && <div className="label-preview-overlay" style={scaledBoxStyle}>{children}</div>}
    </div>
  );
}

// Click-to-toggle grid mirroring the sheet's real cols x rows, rendered
// as a transparent overlay directly on top of the live preview (see
// ScaledSheetFrame) rather than a separate numbered grid below it — the
// admin clicks the actual label they want to mark as already used,
// instead of matching a position number back to a cell by eye. Uses the
// exact same mm-based grid-template/padding/gap as the generated sheet
// HTML's own `.sheet` rule so it lines up with the real cells regardless
// of format. `showGrid` additionally draws a dashed outline on every
// cell — the alignment check — layered on top of the real label content
// rather than replacing it, so turning it on never hides what's already
// on the sheet.
function SheetPositionPicker({ cols, rows, format, blocked, onToggle, showGrid }: { cols: number; rows: number; format: LabelFormat; blocked: Set<number>; onToggle: (pos: number) => void; showGrid: boolean }) {
  const perSheet = cols * rows;
  const gapX = format.gapXMm ?? 0;
  const gapY = format.gapYMm ?? 0;
  return (
    <div
      className="sheet-position-overlay"
      style={{
        padding: `${format.marginTopMm ?? 0}mm 0 0 ${format.marginLeftMm ?? 0}mm`,
        gridTemplateColumns: `repeat(${cols}, ${format.widthMm}mm)`,
        gridTemplateRows: `repeat(${rows}, ${format.heightMm}mm)`,
        columnGap: `${gapX}mm`,
        rowGap: `${gapY}mm`
      }}
    >
      {Array.from({ length: perSheet }, (_, i) => i + 1).map((pos) => (
        <button
          type="button"
          key={pos}
          className={`sheet-pos-cell${blocked.has(pos) ? " blocked" : ""}${showGrid ? " show-grid" : ""}`}
          onClick={() => onToggle(pos)}
          title={blocked.has(pos) ? "Already used — click to mark as available" : "Available — click to mark as already used"}
        />
      ))}
    </div>
  );
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
    const printable = html.replace("</head>", '<script>window.addEventListener("load",function(){window.print()})</script></head>');
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
// Shared by printReceipt below and EmailReceiptModal's send action, so the
// two never drift on which layout a given printStyle setting resolves to
// per department.
function resolvePrintStyle(type: "kitchen" | "counter" | "master", printStyle = "thermal"): "thermal" | "a4" {
  let resolved: "thermal" | "a4" = printStyle === "a4" ? "a4" : "thermal";
  if (printStyle === "master_a4") resolved = type === "master" ? "a4" : "thermal";
  if (printStyle === "dept_a4")   resolved = type !== "master" ? "a4" : "thermal";
  return resolved;
}

async function printReceipt(order: Order, type: "kitchen" | "counter" | "master", printStyle = "thermal", printerName = "") {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  if (items.length === 0) return;

  await ensureLogoDataUri();
  const resolved = resolvePrintStyle(type, printStyle);
  const html = applyColorMode(buildReceiptHtml(order, type, resolved));

  // Distinct from the "Auto-print" setting (which controls whether a
  // NEW order triggers printing automatically at all) — this is about
  // what a MANUAL print action does once triggered: silently send
  // straight to the assigned printer (default), or always show a
  // preview/print dialog first, even when a printer is configured.
  if (printerName && !printPrefs.forcePreview) {
    try { await api.print(printerName, html); return; }
    catch (err) {
      // Falls back to the browser print dialog so the ticket still gets
      // produced somehow, but staff need to actually know the named
      // printer failed — silently substituting a browser dialog for what's
      // supposed to be a direct-to-till-printer job is exactly how this
      // used to go unnoticed (see globalToast's comment above MainApp).
      showToast(`Couldn't print to "${printerName}" (${err instanceof Error ? err.message : "unknown error"}) — opening browser print instead.`, "error");
    }
  }
  printHtml(html);
}

// Sends the exact same styled receipt HTML used for printing (the "master"
// customer-facing receipt) to an email address — a real client is present
// for this manual, staff-triggered action, unlike the automated order_ready/
// payment_received emails (see server/email/receipt.ts on the server,
// which builds a simpler version for those since there's no browser then).
function EmailReceiptModal({ order, printStyle, onClose }: { order: Order; printStyle: string; onClose: () => void }) {
  const [to, setTo] = useState(order.customerEmail ?? "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState("");

  const send = async () => {
    const trimmed = to.trim();
    if (!trimmed) return;
    setSending(true); setResult("");
    try {
      // forEmail (true) builds the logo src against publicBaseUrl, not the
      // data-URI cache ensureLogoDataUri populates — that's print-only now.
      const html = buildReceiptHtml(order, "master", resolvePrintStyle("master", printStyle), true);
      await api.orders.emailReceipt(order.id, trimmed, html);
      setResult("Sent!");
      window.setTimeout(onClose, 1200);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card panel">
        <div className="modal-header">
          <h2>Email receipt</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <label>Email address<input type="email" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" /></label>
          {result && <p className="form-message">{result}</p>}
          <footer className="actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="button" disabled={sending || !to.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</button>
          </footer>
        </div>
      </div>
    </div>
  );
}

// Sends a throwaway test ticket to confirm a configured printer actually
// works, used by the "Test" button next to each printer assignment in Settings.
async function printTestPage(printerName: string): Promise<void> {
  const ts = new Date().toLocaleString(appSettings.locale);
  // A4, not the receipt/label formats' small custom page sizes (80mm
  // thermal roll, etc.) — this test needs to work on WHATEVER printer is
  // assigned, and most real-world printers (any normal office
  // laser/inkjet, which is a lot more common than a thermal receipt
  // roll) have no way to produce a tiny 80mm-wide page at all. Sending
  // one to a printer that only has A4/Letter loaded doesn't error, it
  // just silently sits there unable to match the requested paper size —
  // which looks identical to "the printer is broken" from this button,
  // even though the whole print pipeline is actually working fine.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:20mm}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000}
hr{border:none;border-top:1px dashed #999;margin:12px 0}
.big{font-size:24px;font-weight:bold}.small{font-size:11px;color:#555}
</style></head><body>
<div class="big">NemenchPos</div>
<div>--- TEST PRINT ---</div>
<hr>
<div class="small">${ts}</div>
<div class="small">Printer: ${printerName || "Browser dialog"}</div>
<hr>
<div>If you can read this,</div>
<div>the printer is working.</div>
</body></html>`;
  const printable = applyColorMode(html);

  if (printerName && !printPrefs.forcePreview) {
    try {
      await api.print(printerName, printable);
      showToast(`Test page sent to "${printerName}".`, "info");
      return;
    } catch (err) {
      // The whole point of this button is confirming whether the named
      // printer actually works — silently falling back to a browser
      // dialog here would make a genuinely broken printer look identical
      // to a working one (the browser dialog opens either way), which is
      // exactly the trap that led to this fix in the first place.
      showToast(`Test print to "${printerName}" failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      return;
    }
  }
  printHtml(printable);
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


function tabTitle(tab: Tab) {
  return { orders: "New Order", pos: "POS", queue: "Prep Queue", history: "Order History", products: "Stock", users: "Users", settings: "Settings", reports: "Reports", weighIn: "Weigh-In", statistics: "Statistics", crm: "CRM", consolidate: "Consolidate Order", printLabels: "Print Labels" }[tab];
}

function tabSubtitle(tab: Tab) {
  return {
    orders: "Capture customer details, weights, and cutting notes.",
    pos: "Ring up a walk-in sale and print the receipt.",
    queue: "Move tickets through each stage.",
    history: "Review completed tickets.",
    settings: "System configuration.",
    products: "Manage stock items, prices, and physical counts.",
    users: "Manage staff accounts and PINs.",
    reports: "View and download orders for a date range.",
    weighIn: "Log received stock by weight, batch by batch.",
    statistics: "Sales performance and stock movement per item.",
    crm: "Contacts, message history, and WhatsApp automation.",
    consolidate: "Scan every item to verify a Ready order, then finalize one barcode and receipt for it.",
    printLabels: "Pick a product, set weight/quantity/format, and print with a live preview."
  }[tab];
}
