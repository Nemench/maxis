import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  Scissors,
  Settings,
  Trash2,
  Users
} from "lucide-react";
import { appSettings } from "../shared/settings";
import type {
  CreateOrderInput,
  DeliveryAddress,
  Department,
  DeptStatus,
  Order,
  OrderItemInput,
  OrderStatus,
  Product,
  ProductInput,
  User,
  UserInput
} from "../shared/types";
import { api } from "./api";

type Tab = "orders" | "queue" | "history" | "products" | "users" | "settings" | "reports";

const deptStatusFlow: DeptStatus[] = ["New", "Received", "Ready", "Done"];
const emptyLine: OrderItemInput = { productId: null, name: "", kg: null, quantity: null, notes: "", unitPrice: null, lineTotal: null, department: "counter" };
const EMPTY_PRODUCT: ProductInput = { name: "", category: "", unitDefault: "kg", pricePerUnit: null, prepNotes: "", department: "counter" };

const currency = new Intl.NumberFormat(appSettings.locale, { style: "currency", currency: appSettings.currency });

// ── Auth wrapper ──────────────────────────────────────────────────────────────

export function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem("kot-token");
    if (!token) { setBooting(false); return; }
    api.auth.me()
      .then(setCurrentUser)
      .catch(() => sessionStorage.removeItem("kot-token"))
      .finally(() => setBooting(false));
  }, []);

  const logout = () => { sessionStorage.removeItem("kot-token"); setCurrentUser(null); };

  if (booting) return <div className="boot-screen"><Scissors size={32} /></div>;
  if (!currentUser) return <LoginScreen onLogin={setCurrentUser} />;
  return <MainApp currentUser={currentUser} onLogout={logout} />;
}

// ── Login ─────────────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const { token, user } = await api.auth.login(name, pin);
      sessionStorage.setItem("kot-token", token);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="login-screen">
      <form className="login-card panel" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">
          <img src="/logo.jpg" alt="MAXIS" className="login-logo" />
          <h1>MAXIS</h1>
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

function MainApp({ currentUser, onLogout }: { currentUser: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>(currentUser.role === "kitchen" || currentUser.role === "counter" ? "queue" : "orders");
  const [products, setProducts] = useState<Product[]>([]);
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [autoPrint, setAutoPrint] = useState(false);
  const [printStyle, setPrintStyle] = useState("thermal");
  const [printerMap, setPrinterMap] = useState({ kitchen: "", counter: "", master: "" });

  // Full refresh — products + orders. Only on mount and after mutations.
  const refresh = async () => {
    const [productList, activeList] = await Promise.all([
      api.products.list(),
      api.orders.list("active"),
    ]);
    setProducts(productList);
    setActiveOrders(activeList);
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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.jpg" alt="MAXIS" className="brand-logo" />
          <div>
            <strong>MAXIS</strong>
            <span>{currentUser.name} · {{ admin: "Admin", cashier: "Cashier", master_cashier: "Master Cashier", kitchen: "Kitchen", counter: "Counter" }[currentUser.role]}</span>
          </div>
        </div>
        <nav>
          {(currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier") && (
            <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}><Plus size={18} /> New</button>
          )}
          <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}><ClipboardList size={18} /> Queue</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={18} /> History</button>
          {currentUser.role === "admin" && (
            <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}><Package size={18} /> Stock</button>
          )}
          {currentUser.role === "admin" && (
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={18} /> Users</button>
          )}
          {currentUser.role === "admin" && (
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={18} /> Settings</button>
          )}
          {currentUser.role === "admin" && (
            <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}><BarChart2 size={18} /> Reports</button>
          )}
        </nav>
        <div className="sidebar-footer">
          <button className="secondary" onClick={onLogout}><LogOut size={16} /> Sign out</button>
        </div>
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
        {tab === "products" && <Products products={products} onChanged={refresh} />}
        {tab === "users" && currentUser.role === "admin" && <UsersPanel />}
        {tab === "settings" && currentUser.role === "admin" && (
          <SettingsPanel autoPrint={autoPrint} onAutoPrintChange={setAutoPrint} printStyle={printStyle} onPrintStyleChange={setPrintStyle} printerMap={printerMap} onPrinterMapChange={setPrinterMap} />
        )}
        {tab === "reports" && currentUser.role === "admin" && <ReportsPanel />}
      </main>
    </div>
  );
}

// ── Order entry ───────────────────────────────────────────────────────────────

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

  const [submitError, setSubmitError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSubmitError("");
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
      if (autoPrint && currentUser.role === "master_cashier") {
        void printReceipt(order, "master", printStyle, printerMap.master ?? "");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create order");
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
              title="Remove line" disabled={items.length === 1}
            ><Trash2 size={18} /></button>
          </div>
        ))}
      </div>

      <footer className="actions">
        <button type="button" className="secondary" onClick={() => setItems((cur) => [...cur, { ...emptyLine, department: defaultDept }])}>
          <Plus size={18} /> Add item
        </button>
        <button type="submit" disabled={!canSave}><Save size={18} /> Create Order</button>
      </footer>
      {submitError && <p className="form-error">{submitError}</p>}
    </form>
  );
}

// ── Product combobox ──────────────────────────────────────────────────────────

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

function TicketCard({ order, currentUser, onChanged, printStyle, printerMap }: { order: Order; currentUser: User; onChanged: () => Promise<void>; printStyle: string; printerMap: Record<string, string> }) {
  const visibleItems =
    currentUser.role === "kitchen" ? order.items.filter((i) => i.department === "kitchen") :
    currentUser.role === "counter" ? order.items.filter((i) => i.department === "counter") :
    order.items;

  const total = visibleItems.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);
  const showTotal = currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier";
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
      <div className="customer">
        <div className="customer-top">
          <b>{order.customerName}</b>
          <div className="customer-meta">
            <span>{order.customerPhone}</span>
            <span className={`order-type-badge ${order.orderType}`}>{order.orderType === "delivery" ? "Delivery" : "Pickup"}</span>
          </div>
        </div>
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
      {order.requestedByName && <div className="requested-by">Requested by {order.requestedByName}</div>}
      {order.assignedTo && <div className="assignee-tag">Assigned to: <b>{order.assignedTo}</b></div>}

      <div className="dept-statuses">
        {hasKitchen && <span className={`dept-badge kitchen ds-${order.kitchenStatus.toLowerCase()}`}>Kitchen: {order.kitchenStatus}</span>}
        {hasCounter && <span className={`dept-badge counter ds-${order.counterStatus.toLowerCase()}`}>Counter: {order.counterStatus}</span>}
      </div>

      <ul>
        {visibleItems.map((item) => (
          <li key={item.id}>
            <div>
              <b>{item.name}</b>
              {(currentUser.role === "admin" || currentUser.role === "cashier" || currentUser.role === "master_cashier")
                ? <span className={`item-dept ${item.department}`}>{item.department}</span>
                : null}
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
        {showTotal && total > 0 && <span className="total">{currency.format(total)}</span>}
        <div className="ticket-actions">
          {hasKitchen && <button className="icon-button secondary" onClick={() => void printReceipt(order, "kitchen", printStyle, printerMap.kitchen ?? "")} title="Print kitchen receipt">K</button>}
          {hasCounter && <button className="icon-button secondary" onClick={() => void printReceipt(order, "counter", printStyle, printerMap.counter ?? "")} title="Print counter receipt">C</button>}
          <button className="icon-button" onClick={() => void printReceipt(order, "master", printStyle, printerMap.master ?? "")} title="Print master receipt"><Printer size={18} /></button>
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
                  <button className="icon-button" onClick={() => void printReceipt(order, "master", printStyle, printerMap.master ?? "")} title="Print master receipt"><Printer size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
    </div>
  );
}

// ── Products ──────────────────────────────────────────────────────────────────

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

  const remove = async (id: number) => { await api.products.delete(id); await onChanged(); };

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
        {stockMessage && <div className="form-message">{stockMessage}</div>}
        <footer className="actions">
          {editing.id && <button type="button" className="secondary" onClick={() => { setEditing(EMPTY_PRODUCT); setStockMessage(""); }}>Cancel</button>}
          <button type="submit" disabled={busy}><Save size={18} /> {busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>

      <div className="panel table-panel">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Dept</th><th>R/kg</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.category}</td>
                <td><span className={`dept-badge ${p.department}`}>{p.department}</span></td>
                <td>{p.pricePerUnit ? currency.format(p.pricePerUnit) : ""}</td>
                <td>{p.prepNotes}</td>
                <td className="row-actions">
                  <button type="button" className="secondary" onClick={() => setEditing(p)}>Edit</button>
                  <button type="button" className="icon-button danger" onClick={() => void remove(p.id)} title="Delete"><Trash2 size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Users (admin) ─────────────────────────────────────────────────────────────

const EMPTY_USER: UserInput = { name: "", pin: "", role: "cashier", department: null };
const roleDept = (role: UserInput["role"]): Department | null =>
  role === "kitchen" ? "kitchen" : role === "counter" ? "counter" : null;

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
            const department: Department | null = role === "kitchen" ? "kitchen" : role === "counter" ? "counter" : null;
            setForm({ ...form, role, department });
          }}>
            <option value="cashier">Cashier</option>
            <option value="master_cashier">Master Cashier</option>
            <option value="counter">Counter</option>
            <option value="kitchen">Kitchen</option>
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
              <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.45 }}>
                <td>{u.name}</td>
                <td style={{ textTransform: "capitalize" }}>{u.role.replace("_", " ")}</td>
                <td>{u.isActive ? "Active" : "Inactive"}</td>
                <td>
                  <span className={`online-dot ${online ? "online" : "offline"}`}
                    title={online ? "Online now" : u.lastSeenAt
                      ? `Last seen ${new Date(u.lastSeenAt).toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" })}`
                      : "Never logged in"} />
                  {online ? <span style={{ color: "#16a34a", fontSize: 12, fontWeight: 700 }}>Online</span> : null}
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

function SettingsPanel({ autoPrint, onAutoPrintChange, printStyle, onPrintStyleChange, printerMap, onPrinterMapChange }: { autoPrint: boolean; onAutoPrintChange: (v: boolean) => void; printStyle: string; onPrintStyleChange: (v: string) => void; printerMap: Record<string, string>; onPrinterMapChange: (v: { kitchen: string; counter: string; master: string }) => void }) {
  const [msg, setMsg] = useState("");
  const [availablePrinters, setAvailablePrinters] = useState<string[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [importing, setImporting] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const fetchPrinters = async () => {
    setLoadingPrinters(true);
    try { setAvailablePrinters(await api.printers.list()); }
    catch { /* ignore */ }
    finally { setLoadingPrinters(false); }
  };

  useEffect(() => { void fetchPrinters(); }, []);

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

  return (
    <div className="panel settings-panel">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Printing</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Auto-print</strong>
            <p>Automatically print the master receipt when a Master Cashier creates an order.</p>
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
          <p className="settings-hint">Assign each receipt type to a CUPS printer on the server. Leave blank to use the browser print dialog.</p>
          <div className="printer-assignments">
            {([ ["Kitchen receipt", "kitchenPrinter", "kitchen"], ["Counter receipt", "counterPrinter", "counter"], ["Master receipt", "masterPrinter", "master"] ] as [string, string, string][]).map(([label, key, mapKey]) => (
              <label key={key}>
                {label}
                <select value={printerMap[mapKey] ?? ""} onChange={(e) => void changePrinter(key, e.target.value)}>
                  <option value="">— Browser dialog —</option>
                  {availablePrinters.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            ))}
          </div>
          {availablePrinters.length === 0 && !loadingPrinters && (
            <p className="settings-hint">No printers found on this machine via CUPS.</p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>Products &amp; backup</h3>
        <div className="setting-row">
          <div className="setting-info">
            <strong>Product list</strong>
            <p>Export saves your product catalog as a CSV. Import loads from one — existing products are updated by name. Use Export as your backup and Import to restore.</p>
          </div>
          <div className="setting-actions">
            <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => void handleImport(e)} />
            <button type="button" className="secondary" disabled={importing} onClick={() => csvInputRef.current?.click()}>
              {importing ? "Importing…" : "Import"}
            </button>
            <button type="button" className="secondary" onClick={() => void api.products.export()}>
              Export
            </button>
          </div>
        </div>
      </section>

      {msg && <div className="form-message">{msg}</div>}
    </div>
  );
}

// ── Reports (admin) ───────────────────────────────────────────────────────────

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

function fmtReceiptTime(rt: string): string {
  if (!rt) return "";
  const d = new Date(rt);
  if (isNaN(d.getTime())) return rt;
  return d.toLocaleString(appSettings.locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildReceiptHtml(order: Order, type: "kitchen" | "counter" | "master", style: "thermal" | "a4"): string {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  const label = type === "kitchen" ? "Kitchen Order" : type === "counter" ? "Counter Order" : "Receipt";
  const showPrices = type !== "kitchen";
  const total = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const d = new Date(order.createdAt);
  const dateStr = d.toLocaleDateString(appSettings.locale);
  const timeStr = d.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" });

  const addrLines = order.orderType === "delivery" && order.deliveryAddress?.street
    ? [order.deliveryAddress.street, order.deliveryAddress.area, order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `Apt ${order.deliveryAddress.apartment}` : ""].filter(Boolean)
    : [];
  const requestedAtLine = order.requestedTime ? `${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${fmtReceiptTime(order.requestedTime)}` : "";

  if (style === "a4") {
    const rows = items.map((i) => `<tr>
      <td><strong>${esc(i.name)}</strong>${i.notes ? `<div class="note">${esc(i.notes)}</div>` : ""}</td>
      ${showPrices ? `<td>${i.unitPrice != null ? `R${i.unitPrice.toFixed(2)}` : "—"}</td>` : ""}
      <td>${i.kg ? `${i.kg} kg` : i.quantity ? `×${i.quantity}` : "—"}</td>
      ${showPrices ? `<td class="right">${i.lineTotal != null ? `<strong>R${i.lineTotal.toFixed(2)}</strong>` : "—"}</td>` : ""}
    </tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} ${esc(order.ticketNumber)}</title><style>
@page{size:A4;margin:20mm}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e;line-height:1.5}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d2b6b;padding-bottom:16px;margin-bottom:20px}
.brand{font-size:22px;font-weight:800;color:#c41f1f}.rtype{font-size:14px;font-weight:700;color:#0d2b6b;margin-top:4px}
.hdr-r{text-align:right}.tnum{font-size:16px;font-weight:800;color:#0d2b6b}.dt{font-size:12px;color:#666;margin-top:2px}
.cbox{background:#f0f4fd;border:1px solid #c8d5ee;border-radius:8px;padding:14px 18px;margin-bottom:20px}
.clbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#5a6480;margin-bottom:8px}
.cname{font-size:18px;font-weight:700;color:#0d2b6b}.cline{font-size:13px;color:#333;margin-top:3px}
.del{color:#c41f1f;font-weight:700}.ttag{color:#0d2b6b;font-weight:600}
table{width:100%;border-collapse:collapse}
thead tr{background:#0d2b6b}
th{color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
td{padding:9px 12px;border-bottom:1px solid #e8eef7;vertical-align:top}
tr:nth-child(even) td{background:#f8f9fc}tr:last-child td{border-bottom:none}
.right{text-align:right}.note{font-size:11px;color:#888;margin-top:2px;font-style:italic}
.tot{display:flex;justify-content:flex-end;gap:20px;align-items:baseline;border-top:2px solid #0d2b6b;padding-top:12px;margin-top:8px}
.tot-lbl{font-size:13px;color:#5a6480}.tot-val{font-size:22px;font-weight:800;color:#0d2b6b}
.footer{margin-top:40px;text-align:center;color:#888;font-size:12px;border-top:1px solid #e0e6f0;padding-top:12px}
</style></head><body>
<div class="hdr">
  <div><div class="brand">MAXIS KOSHER BUTCHERY</div><div class="rtype">${esc(label)}</div></div>
  <div class="hdr-r"><div class="tnum">${esc(order.ticketNumber)}</div><div class="dt">${dateStr} · ${timeStr}</div></div>
</div>
<div class="cbox">
  <div class="clbl">Customer</div>
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cline">${esc(order.customerPhone)}</div>
  <div class="cline ${order.orderType === "delivery" ? "del" : ""}">${order.orderType === "delivery" ? "★ DELIVERY" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="cline">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="cline ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="cline">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="cline">Assigned to: <strong>${esc(order.assignedTo)}</strong></div>` : ""}
</div>
<table>
  <thead><tr>
    <th>Item</th>
    ${showPrices ? "<th>Unit price</th>" : ""}
    <th>Qty / weight</th>
    ${showPrices ? '<th class="right">Total</th>' : ""}
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${showPrices && total > 0 ? `<div class="tot"><div class="tot-lbl">ORDER TOTAL</div><div class="tot-val">R${total.toFixed(2)}</div></div>` : ""}
<div class="footer">Thank you for your order — MAXIS Discount Kosher Butchery</div>
</body></html>`;
  }

  // Thermal
  const rows = items.map((i) => {
    const qty = [i.kg ? `${i.kg} kg` : "", i.quantity ? `×${i.quantity}` : ""].filter(Boolean).join("  ");
    const amt = showPrices && i.lineTotal ? `R${i.lineTotal.toFixed(2)}` : "";
    return `<div class="item">
  <div class="iname">${esc(i.name)}</div>
  <div class="isub"><span>${esc(qty)}${i.notes ? `  <em>${esc(i.notes)}</em>` : ""}</span>${amt ? `<span class="amt">${amt}</span>` : ""}</div>
</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)} ${esc(order.ticketNumber)}</title><style>
@page{size:80mm auto;margin:4mm 5mm}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:12px;color:#000;line-height:1.45}
.center{text-align:center}
.shop{font-size:14px;font-weight:800;color:#0d2b6b;letter-spacing:.3px}
.lbl{font-size:13px;font-weight:700;letter-spacing:.5px;margin:2px 0}
.sub{font-size:11px;color:#555}
hr{border:none;border-top:1px dashed #bbb;margin:6px 0}
.cust{margin:4px 0}
.cname{font-size:13px;font-weight:700}
.cphone{font-size:12px;color:#333}
.del{font-weight:700;color:#c41f1f}
.addr{font-size:11px;color:#444;margin-top:1px}
.ttag{font-size:11px;font-weight:700;color:#0d2b6b;margin-top:2px}
.by{font-size:10px;color:#666;margin-top:2px}
.item{padding:4px 0;border-bottom:1px dotted #ddd}
.item:last-child{border-bottom:none}
.iname{font-weight:700}
.isub{display:flex;justify-content:space-between;font-size:11px;color:#555;margin-top:1px}
.amt{font-weight:700;color:#000;white-space:nowrap;padding-left:8px}
.tot{display:flex;justify-content:space-between;font-weight:800;font-size:14px;padding-top:5px}
.footer{text-align:center;font-size:10px;color:#888;margin-top:6px}
</style></head><body>
<div class="center">
  <div class="shop">MAXIS KOSHER BUTCHERY</div>
  <div class="lbl">${esc(label.toUpperCase())}</div>
  <div class="sub">${esc(order.ticketNumber)} &middot; ${dateStr} ${timeStr}</div>
</div>
<hr>
<div class="cust">
  <div class="cname">${esc(order.customerName)}</div>
  <div class="cphone">${esc(order.customerPhone)}</div>
  <div class="${order.orderType === "delivery" ? "del" : "cphone"}">${order.orderType === "delivery" ? "★ DELIVERY" : "Pickup"}</div>
  ${addrLines.map((l) => `<div class="addr">${esc(l)}</div>`).join("")}
  ${requestedAtLine ? `<div class="ttag">${esc(requestedAtLine)}</div>` : ""}
  ${order.requestedByName ? `<div class="by">Served by: ${esc(order.requestedByName)}</div>` : ""}
  ${order.assignedTo ? `<div class="by">Assigned to: <strong>${esc(order.assignedTo)}</strong></div>` : ""}
</div>
<hr>
${rows}
${showPrices && total > 0 ? `<hr><div class="tot"><span>TOTAL</span><span>R${total.toFixed(2)}</span></div>` : ""}
<div class="footer">Thank you — Maxis Discount Kosher Butchery</div>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function printHtml(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;width:0;height:0;border:none;opacity:0;top:-9999px";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  iframe.contentWindow!.onafterprint = () => { document.body.removeChild(iframe); };
  setTimeout(() => { iframe.contentWindow?.print(); }, 150);
}

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

// ── Urgency helpers ───────────────────────────────────────────────────────────

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

function nextDeptStatus(status: DeptStatus): DeptStatus | null {
  const i = deptStatusFlow.indexOf(status);
  return i === -1 ? null : (deptStatusFlow[i + 1] ?? null);
}

function calculateLineTotal(item: OrderItemInput) {
  if (!item.unitPrice || !item.kg) return null;
  return Number((item.kg * item.unitPrice).toFixed(2));
}

function tabTitle(tab: Tab) {
  return { orders: "New Order", queue: "Prep Queue", history: "Order History", products: "Stock", users: "Users", settings: "Settings", reports: "Reports" }[tab];
}

function tabSubtitle(tab: Tab) {
  return {
    orders: "Capture customer details, weights, and cutting notes.",
    queue: "Move tickets through each stage.",
    history: "Review completed tickets.",
    settings: "System configuration.",
    products: "Manage stock items and prices.",
    users: "Manage staff accounts and PINs.",
    reports: "View and download orders for a date range."
  }[tab];
}
