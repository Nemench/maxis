import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  History,
  LogOut,
  Package,
  Plus,
  Printer,

  Save,
  Scissors,
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

type Tab = "orders" | "queue" | "history" | "products" | "users";

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

  const refresh = async () => {
    const [productList, activeList, doneList] = await Promise.all([
      api.products.list(),
      api.orders.list("active"),
      api.orders.list("history")
    ]);
    setProducts(productList);
    setActiveOrders(activeList);
    setHistoryOrders(doneList);
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const id = setInterval(() => void refresh(), 5000);
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
            onCreated={async (order) => { notify(`Created ${order.ticketNumber}`); await refresh(); setTab("queue"); }}
          />
        )}
        {tab === "queue" && <Queue orders={activeOrders} currentUser={currentUser} onChanged={refresh} />}
        {tab === "history" && <HistoryView orders={historyOrders} />}
        {tab === "products" && <Products products={products} onChanged={refresh} />}
        {tab === "users" && currentUser.role === "admin" && <UsersPanel />}
      </main>
    </div>
  );
}

// ── Order entry ───────────────────────────────────────────────────────────────

function OrderEntry({ products, currentUser, onCreated }: { products: Product[]; currentUser: User; onCreated: (order: Order) => void }) {
  const defaultDept: Department = currentUser.department ?? "counter";
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [orderType, setOrderType] = useState<"pickup" | "delivery">("pickup");
  const [addr, setAddr] = useState<DeliveryAddress>({ street: "", area: "", buildingType: "", apartment: "" });
  const [requestedTime, setRequestedTime] = useState("");
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
      items: items
        .filter((i) => i.name.trim())
        .map((i) => ({ ...i, kg: i.kg ? Number(i.kg) : null, quantity: i.quantity ? Number(i.quantity) : null, lineTotal: calculateLineTotal(i) }))
    };
    const order = await api.orders.create(payload);
    setCustomerName(""); setCustomerPhone(""); setOrderType("pickup");
    setAddr({ street: "", area: "", buildingType: "", apartment: "" }); setRequestedTime("");
    setItems([{ ...emptyLine, department: defaultDept }]);
    onCreated(order);
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
        <input type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
      </label>

      <div className="line-list">
        {items.map((item, index) => (
          <div className="line-row" key={index}>
            <label>
              Product
              <select value={item.productId ?? ""} onChange={(e) => chooseProduct(index, e.target.value)}>
                <option value="">Free text</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>
              Item
              <input value={item.name} onChange={(e) => setLine(index, { name: e.target.value })} required />
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

// ── Queue ─────────────────────────────────────────────────────────────────────

function Queue({ orders, currentUser, onChanged }: { orders: Order[]; currentUser: User; onChanged: () => Promise<void> }) {
  if (orders.length === 0) return <EmptyState title="No active tickets" detail="New orders will appear here." />;
  return (
    <div className="ticket-grid">
      {orders.map((order) => <TicketCard key={order.id} order={order} currentUser={currentUser} onChanged={onChanged} />)}
    </div>
  );
}

// ── Ticket card ───────────────────────────────────────────────────────────────

function TicketCard({ order, currentUser, onChanged }: { order: Order; currentUser: User; onChanged: () => Promise<void> }) {
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
        <span className="badge">{order.status}</span>
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
          <span className="requested-time">{order.orderType === "delivery" ? "Deliver at" : "Pickup at"} {order.requestedTime}</span>
        )}
      </div>
      {order.requestedByName && <div className="requested-by">Requested by {order.requestedByName}</div>}

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
          {hasKitchen && <button className="icon-button secondary" onClick={() => printReceipt(order, "kitchen")} title="Print kitchen receipt">K</button>}
          {hasCounter && <button className="icon-button secondary" onClick={() => printReceipt(order, "counter")} title="Print counter receipt">C</button>}
          <button className="icon-button" onClick={() => printReceipt(order, "master")} title="Print master receipt"><Printer size={18} /></button>
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

function HistoryView({ orders }: { orders: Order[] }) {
  if (orders.length === 0) return <EmptyState title="No completed orders yet" detail="Done tickets are kept here." />;
  return (
    <div className="panel table-panel">
      <table>
        <thead>
          <tr><th>Ticket</th><th>Customer</th><th>Phone</th><th>Requested by</th><th>Items</th><th>Completed</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>{order.ticketNumber}</td>
              <td>{order.customerName}</td>
              <td>{order.customerPhone}</td>
              <td>{order.requestedByName ?? "—"}</td>
              <td>{order.items.length}</td>
              <td>{new Date(order.updatedAt).toLocaleString(appSettings.locale)}</td>
              <td>
                <button className="icon-button" onClick={() => printReceipt(order, "master")} title="Print master receipt"><Printer size={18} /></button>
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
  useEffect(() => { void load(); }, []);

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
    await api.users.update(user.id, { isActive: user.isActive ? 0 : 1 });
    await load();
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
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.45 }}>
                <td>{u.name}</td>
                <td style={{ textTransform: "capitalize" }}>{u.role}</td>
                <td>{u.isActive ? "Active" : "Inactive"}</td>
                <td className="row-actions">
                  <button type="button" className="secondary" onClick={() => startEdit(u)}>Edit</button>
                  <button type="button" className="secondary" onClick={() => void toggleActive(u)}>
                    {u.isActive ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Print ─────────────────────────────────────────────────────────────────────

function printReceipt(order: Order, type: "kitchen" | "counter" | "master") {
  const items = type === "master" ? order.items : order.items.filter((i) => i.department === type);
  if (items.length === 0) return;

  const label = { kitchen: "KITCHEN ORDER", counter: "COUNTER ORDER", master: "RECEIPT" }[type];
  const showPrices = type !== "kitchen";
  const total = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const d = new Date(order.createdAt);
  const dateStr = d.toLocaleDateString(appSettings.locale);
  const timeStr = d.toLocaleTimeString(appSettings.locale, { hour: "2-digit", minute: "2-digit" });

  const itemRows = items.map((i) => {
    const qty = [i.kg ? `${i.kg} kg` : "", i.quantity ? `×${i.quantity}` : ""].filter(Boolean).join("  ");
    const lineTotal = showPrices && i.lineTotal ? `R${i.lineTotal.toFixed(2)}` : "";
    return `
      <div class="item">
        <div class="item-name">${i.name}</div>
        <div class="item-sub">
          <span>${qty}${i.notes ? `  ${i.notes}` : ""}</span>
          ${lineTotal ? `<span class="amt">${lineTotal}</span>` : ""}
        </div>
      </div>`;
  }).join("");

  const logoUrl = `${window.location.origin}/logo.jpg`;
  const win = window.open("", "_blank", "width=380,height=720");
  if (!win) return;

  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${label} — ${order.ticketNumber}</title>
  <style>
    @page { size: 80mm auto; margin: 4mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', Courier, monospace; font-size: 12px; width: 72mm; margin: 0 auto; line-height: 1.5; color: #000; }
    .center { text-align: center; }
    .sep  { border: none; border-top: 1px dashed #999; margin: 7px 0; }
    .sep2 { border: none; border-top: 2px solid #000; margin: 7px 0; }
    .logo { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; margin-bottom: 4px; }
    .shop-name { font-size: 13px; font-weight: bold; color: #c41f1f; letter-spacing: 0.5px; }
    .label { font-size: 15px; font-weight: bold; letter-spacing: 1px; color: #0d2b6b; margin-top: 2px; }
    .ticket-num { font-size: 12px; font-weight: bold; color: #333; }
    .datetime { font-size: 11px; color: #555; }
    .customer { margin: 4px 0; }
    .customer b { font-size: 13px; }
    .delivery-tag { font-weight: bold; color: #c41f1f; font-size: 12px; }
    .addr { font-size: 11px; color: #333; margin-top: 2px; }
    .time-tag { font-size: 11px; font-weight: bold; color: #0d2b6b; margin-top: 2px; }
    .item { margin: 5px 0; }
    .item-name { font-weight: bold; }
    .item-sub { display: flex; justify-content: space-between; color: #444; font-size: 11px; margin-top: 1px; }
    .amt { font-weight: bold; color: #000; white-space: nowrap; padding-left: 8px; }
    .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; margin: 4px 0; color: #0d2b6b; }
    .served-by { font-size: 10px; color: #666; margin-top: 3px; }
    .thank-you { font-size: 11px; color: #555; }
    @media print { body { width: 72mm; } }
  </style>
</head>
<body>
  <div class="center">
    <img class="logo" src="${logoUrl}" alt="MAXIS" />
    <div class="shop-name">MAXIS KOSHER BUTCHERY</div>
    <div class="label">${label}</div>
    <div class="ticket-num">${order.ticketNumber}</div>
    <div class="datetime">${dateStr} &nbsp; ${timeStr}</div>
  </div>
  <hr class="sep">
  <div class="customer">
    <b>${order.customerName}</b><br>
    ${order.customerPhone}<br>
    <span class="${order.orderType === "delivery" ? "delivery-tag" : ""}">${order.orderType === "delivery" ? "*** DELIVERY ***" : "Pickup"}</span>
    ${order.orderType === "delivery" && order.deliveryAddress?.street ? `
      <div class="addr">${order.deliveryAddress.street}</div>
      <div class="addr">${order.deliveryAddress.area}</div>
      ${order.deliveryAddress.buildingType === "building" && order.deliveryAddress.apartment ? `<div class="addr">Apt: ${order.deliveryAddress.apartment}</div>` : ""}
    ` : ""}
    ${order.requestedTime ? `<div class="time-tag">${order.orderType === "delivery" ? "Deliver at" : "Pickup at"}: ${order.requestedTime}</div>` : ""}
    ${order.requestedByName ? `<div class="served-by">Served by: ${order.requestedByName}</div>` : ""}
  </div>
  <hr class="sep">
  ${itemRows}
  ${showPrices && total > 0 ? `<hr class="sep2"><div class="total-row"><span>TOTAL</span><span>R${total.toFixed(2)}</span></div>` : ""}
  <hr class="sep">
  <div class="center thank-you">Thank you for your order</div>
  <script>
    window.onload = function() {
      window.print();
      window.onafterprint = function() { window.close(); };
    };
  </script>
</body>
</html>`);
  win.document.close();
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
  return { orders: "New Order", queue: "Prep Queue", history: "Order History", products: "Stock", users: "Users" }[tab];
}

function tabSubtitle(tab: Tab) {
  return {
    orders: "Capture customer details, weights, and cutting notes.",
    queue: "Move tickets through each stage.",
    history: "Review completed tickets.",
    products: "Manage stock items and prices.",
    users: "Manage staff accounts and PINs."
  }[tab];
}
