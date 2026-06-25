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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
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
    const order = await api.orders.create(payload);
    setCustomerName(""); setCustomerPhone(""); setOrderType("pickup");
    setAddr({ street: "", area: "", buildingType: "", apartment: "" }); setRequestedTime(""); setAssignedTo("");
    setItems([{ ...emptyLine, department: defaultDept }]);
    onCreated(order);
    if (autoPrint && currentUser.role === "master_cashier") {
      void printReceipt(order, "master", printStyle, printerMap.master ?? "");
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

function SettingsPanel({ autoPrint, onAutoPrintChange, printStyle, onPrintStyleChange, printerMap, onPrinterMapChange }: { autoPrint: boolean; onAutoPrintChange: (v: boolean) => void; printStyle: string; onPrintStyleChange: (v: string) => void; printerMap: Record<string, string>; onPrinterMapChange: (v: Record<string, string>) => void }) {
  const [msg, setMsg] = useState("");
  const [availablePrinters, setAvailablePrinters] = useState<string[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);

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
    onPrinterMapChange({ ...printerMap, [key.replace("Printer", "")]: value });
    setMsg("Printer assignment saved");
    window.setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="panel settings-panel">
      <h2>System Settings</h2>
      <div className="setting-row">
        <div className="setting-info">
          <strong>Auto-print on Master Cashier order</strong>
          <p>Automatically opens the print dialog when a Master Cashier creates a new order. Turn off during setup and testing.</p>
        </div>
        <button type="button" className={autoPrint ? "" : "secondary"} onClick={() => void toggle()}>
          {autoPrint ? "On" : "Off"}
        </button>
      </div>
      <div className="setting-row">
        <div className="setting-info">
          <strong>Receipt format</strong>
          <p>Choose between 80mm thermal strips or full A4 pages. You can also mix: A4 for the master receipt and thermal for kitchen/counter, or vice versa.</p>
        </div>
        <select value={printStyle} style={{ width: 260 }} onChange={(e) => void changePrintStyle(e.target.value)}>
          <option value="thermal">All receipts — thermal (80mm)</option>
          <option value="a4">All receipts — A4</option>
          <option value="master_a4">Master receipt A4 · dept receipts thermal</option>
          <option value="dept_a4">Master receipt thermal · dept receipts A4</option>
        </select>
      </div>
      <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
          <div className="setting-info">
            <strong>Printer assignments</strong>
            <p>Assign each receipt type to a printer on the server. Printers must be connected to or accessible from the server machine via CUPS. Leave blank to use the browser print dialog.</p>
          </div>
          <button type="button" className="secondary" onClick={() => void fetchPrinters()} disabled={loadingPrinters}>
            {loadingPrinters ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div className="printer-assignments">
          {([ ["Kitchen receipt", "kitchenPrinter", "kitchen"], ["Counter receipt", "counterPrinter", "counter"], ["Master receipt", "masterPrinter", "master"] ] as [string, string, string][]).map(([label, key, mapKey]) => (
            <label key={key}>
              {label}
              <select value={printerMap[mapKey] ?? ""} onChange={(e) => void changePrinter(key, e.target.value)}>
                <option value="">— Browser print dialog —</option>
                {availablePrinters.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          ))}
        </div>
        {availablePrinters.length === 0 && !loadingPrinters && (
          <p style={{ fontSize: 12, color: "var(--muted)" }}>No printers found. Make sure CUPS is running and printers are configured on the server.</p>
        )}
      </div>
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

async function printReceipt(order: Order, type: "kitchen" | "counter" | "master", printStyle = "thermal", printerName = "") {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  if (items.length === 0) return;

  // Resolve effective style for this receipt type
  let resolved = printStyle;
  if (printStyle === "master_a4") resolved = type === "master" ? "a4" : "thermal";
  if (printStyle === "dept_a4")   resolved = type !== "master" ? "a4" : "thermal";

  const label = { kitchen: "KITCHEN ORDER", counter: "COUNTER ORDER", master: "RECEIPT" }[type];
  const showPrices = type !== "kitchen";
  const total = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const d = new Date(order.createdAt);
  const dateStr = d.toLocaleDateString(appSettings.locale);
  const timeStr = d.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" });
  const logoUrl = `${window.location.origin}/logo.jpg`;

  let html: string;

  if (resolved === "a4") {
    const a4Rows = items.map((i) => `
      <tr>
        <td><b>${i.name}</b>${i.notes ? `<div class="item-note">${i.notes}</div>` : ""}</td>
        ${showPrices ? `<td>${i.unitPrice != null ? `R${i.unitPrice.toFixed(2)}` : "—"}</td>` : ""}
        <td>${i.kg ? `${i.kg} kg` : "—"}</td>
        <td>${i.quantity ? `×${i.quantity}` : "—"}</td>
        ${showPrices ? `<td style="text-align:right;font-weight:700">${i.lineTotal != null ? `R${i.lineTotal.toFixed(2)}` : "—"}</td>` : ""}
      </tr>`).join("");
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${label} — ${order.ticketNumber}</title><style>
      @page{size:A4;margin:18mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid #0d2b6b;margin-bottom:20px}
      .hdr-left .shop{font-size:20px;font-weight:800;color:#c41f1f}.hdr-left .type{font-size:15px;font-weight:700;color:#0d2b6b;margin-top:4px}
      .hdr-right{text-align:right}.logo{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #0d2b6b}
      .tnum{font-size:14px;font-weight:700;color:#0d2b6b;margin-top:6px}.dt{font-size:12px;color:#666;margin-top:2px}
      .cbox{border:1px solid #c8d5ee;border-radius:8px;padding:14px 18px;margin-bottom:20px;background:#f4f7fd}
      .clabel{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6480;font-weight:700;margin-bottom:8px}
      .cname{font-size:16px;font-weight:700;color:#0d2b6b}.cline{font-size:13px;color:#333;margin-top:4px}
      .del{color:#c41f1f;font-weight:700}.ttag{color:#0d2b6b;font-weight:600}
      table{width:100%;border-collapse:collapse;margin-bottom:8px}thead tr{background:#0d2b6b}
      th{color:#fff;padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap}
      td{padding:9px 12px;border-bottom:1px solid #e8eef7;font-size:13px;vertical-align:top}
      tr:nth-child(even) td{background:#f8f9fc}tr:last-child td{border-bottom:none}
      .item-note{font-size:11px;color:#666;margin-top:2px}
      .tot{display:flex;justify-content:flex-end;padding:12px 12px 0;border-top:2px solid #0d2b6b;margin-top:8px;gap:24px;align-items:baseline}
      .tot-label{color:#555;font-size:13px}.tot-value{font-size:20px;font-weight:800;color:#0d2b6b}
      .footer{margin-top:40px;text-align:center;color:#888;font-size:12px;border-top:1px solid #e0e6f0;padding-top:12px}
    </style></head><body>
    <div class="hdr">
      <div class="hdr-left"><div class="shop">MAXIS KOSHER BUTCHERY</div><div class="type">${label}</div></div>
      <div class="hdr-right"><img class="logo" src="${logoUrl}" alt="MAXIS"><div class="tnum">${order.ticketNumber}</div><div class="dt">${dateStr} &nbsp; ${timeStr}</div></div>
    </div>
    <div class="cbox">
      <div class="clabel">Customer Details</div>
      <div class="cname">${order.customerName}</div>
      <div class="cline">${order.customerPhone}</div>
      <div class="cline ${order.orderType === "delivery" ? "del" : ""}">${order.orderType === "delivery" ? "★ DELIVERY" : "Pickup"}</div>
      ${order.orderType === "delivery" && order.deliveryAddress?.street ? `<div class="cline">${order.deliveryAddress.street}, ${order.deliveryAddress.area}${order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `, Apt ${order.deliveryAddress.apartment}` : ""}</div>` : ""}
      ${order.requestedTime ? `<div class="cline ttag">${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${fmtReceiptTime(order.requestedTime)}</div>` : ""}
      ${order.requestedByName ? `<div class="cline">Served by: ${order.requestedByName}</div>` : ""}
      ${order.assignedTo ? `<div class="cline">Assigned to: <b>${order.assignedTo}</b></div>` : ""}
    </div>
    <table><thead><tr><th>Item</th>${showPrices ? "<th>R/kg</th>" : ""}<th>Kg</th><th>Qty</th>${showPrices ? '<th style="text-align:right">Total</th>' : ""}</tr></thead>
    <tbody>${a4Rows}</tbody></table>
    ${showPrices && total > 0 ? `<div class="tot"><div class="tot-label">ORDER TOTAL</div><div class="tot-value">R${total.toFixed(2)}</div></div>` : ""}
    <div class="footer">Thank you for your order — MAXIS Discount Kosher Butchery</div>
    <script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};}</script>
    </body></html>`;
  } else {
    const thermalRows = items.map((i) => {
      const qty = [i.kg ? `${i.kg} kg` : "", i.quantity ? `×${i.quantity}` : ""].filter(Boolean).join("  ");
      const lineTotal = showPrices && i.lineTotal ? `R${i.lineTotal.toFixed(2)}` : "";
      return `<div class="item"><div class="item-name">${i.name}</div><div class="item-sub"><span>${qty}${i.notes ? `  ${i.notes}` : ""}</span>${lineTotal ? `<span class="amt">${lineTotal}</span>` : ""}</div></div>`;
    }).join("");
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${label} — ${order.ticketNumber}</title><style>
      @page{size:80mm auto;margin:4mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Courier New',Courier,monospace;font-size:12px;width:72mm;margin:0 auto;line-height:1.5;color:#000}
      .center{text-align:center}.sep{border:none;border-top:1px dashed #999;margin:7px 0}.sep2{border:none;border-top:2px solid #000;margin:7px 0}
      .logo{width:52px;height:52px;border-radius:50%;object-fit:cover;margin-bottom:4px}
      .shop-name{font-size:13px;font-weight:bold;color:#c41f1f;letter-spacing:.5px}
      .label{font-size:15px;font-weight:bold;letter-spacing:1px;color:#0d2b6b;margin-top:2px}
      .ticket-num{font-size:12px;font-weight:bold;color:#333}.datetime{font-size:11px;color:#555}
      .customer{margin:4px 0}.customer b{font-size:13px}
      .delivery-tag{font-weight:bold;color:#c41f1f;font-size:12px}
      .addr{font-size:11px;color:#333;margin-top:2px}.time-tag{font-size:11px;font-weight:bold;color:#0d2b6b;margin-top:2px}
      .item{margin:5px 0}.item-name{font-weight:bold}
      .item-sub{display:flex;justify-content:space-between;color:#444;font-size:11px;margin-top:1px}
      .amt{font-weight:bold;color:#000;white-space:nowrap;padding-left:8px}
      .total-row{display:flex;justify-content:space-between;font-weight:bold;font-size:14px;margin:4px 0;color:#0d2b6b}
      .served-by{font-size:10px;color:#666;margin-top:3px}.thank-you{font-size:11px;color:#555}
      @media print{body{width:72mm}}
    </style></head><body>
    <div class="center">
      <img class="logo" src="${logoUrl}" alt="MAXIS">
      <div class="shop-name">MAXIS KOSHER BUTCHERY</div>
      <div class="label">${label}</div>
      <div class="ticket-num">${order.ticketNumber}</div>
      <div class="datetime">${dateStr} &nbsp; ${timeStr}</div>
    </div>
    <hr class="sep">
    <div class="customer">
      <b>${order.customerName}</b><br>${order.customerPhone}<br>
      <span class="${order.orderType === "delivery" ? "delivery-tag" : ""}">${order.orderType === "delivery" ? "*** DELIVERY ***" : "Pickup"}</span>
      ${order.orderType === "delivery" && order.deliveryAddress?.street ? `<div class="addr">${order.deliveryAddress.street}</div><div class="addr">${order.deliveryAddress.area}</div>${order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `<div class="addr">Apt: ${order.deliveryAddress.apartment}</div>` : ""}` : ""}
      ${order.requestedTime ? `<div class="time-tag">${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${fmtReceiptTime(order.requestedTime)}</div>` : ""}
      ${order.requestedByName ? `<div class="served-by">Served by: ${order.requestedByName}</div>` : ""}
      ${order.assignedTo ? `<div class="served-by">Assigned to: <b>${order.assignedTo}</b></div>` : ""}
    </div>
    <hr class="sep">
    ${thermalRows}
    ${showPrices && total > 0 ? `<hr class="sep2"><div class="total-row"><span>TOTAL</span><span>R${total.toFixed(2)}</span></div>` : ""}
    <hr class="sep">
    <div class="center thank-you">Thank you for your order</div>
    <script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};}</script>
    </body></html>`;
  }

  if (printerName) {
    try {
      await api.print(printerName, html);
    } catch {
      // Fall back to browser dialog on server print failure
      const win = window.open("", "_blank", resolved === "a4" ? "width=900,height=700" : "width=380,height=720");
      if (win) { win.document.write(html); win.document.close(); }
    }
  } else {
    const win = window.open("", "_blank", resolved === "a4" ? "width=900,height=700" : "width=380,height=720");
    if (win) { win.document.write(html); win.document.close(); }
  }
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
