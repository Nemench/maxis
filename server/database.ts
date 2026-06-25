import BetterSqlite3 from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Product, ProductInput,
  Order, OrderItem, CreateOrderInput, OrderStatus,
  User, UserInput,
  Department, DeptStatus, DeliveryAddress
} from "../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class KotDatabase {
  private db!: BetterSqlite3.Database;

  initialize() {
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new BetterSqlite3(path.join(dataDir, "maxis.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seed();
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  listUsers(): User[] {
    return this.db
      .prepare("SELECT id, name, role, department, isActive, createdAt, lastSeenAt FROM users ORDER BY name")
      .all() as User[];
  }

  touchLastSeen(id: number): void {
    this.db.prepare("UPDATE users SET lastSeenAt = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  getUser(id: number): User | null {
    return this.db
      .prepare("SELECT id, name, role, department, isActive, createdAt FROM users WHERE id = ?")
      .get(id) as User | null;
  }

  getUserByName(name: string): (User & { pin: string }) | null {
    return this.db
      .prepare("SELECT id, name, pin, role, department, isActive, createdAt FROM users WHERE lower(name) = lower(?) AND isActive = 1")
      .get(name) as (User & { pin: string }) | null;
  }

  createUser(input: UserInput): User {
    if (!input.pin || input.pin.length < 4 || input.pin.length > 8 || !/^\d+$/.test(input.pin)) {
      throw new Error("PIN must be 4–8 digits");
    }
    const hash = bcrypt.hashSync(input.pin, 10);
    const now = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO users (name, pin, role, department, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)")
      .run(input.name.trim(), hash, input.role, input.department ?? null, now);
    return this.getUser(Number(result.lastInsertRowid))!;
  }

  updateUser(id: number, input: Partial<UserInput & { isActive: number }>): User {
    const user = this.getUser(id);
    if (!user) throw new Error("User not found");
    if (input.isActive === 0 && user.role === "admin") {
      const { count } = this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND isActive = 1 AND id != ?").get(id) as { count: number };
      if (count === 0) throw new Error("Cannot deactivate the only active admin account");
    }
    const now = new Date().toISOString();
    if (input.pin) {
      if (!/^\d{4,8}$/.test(input.pin)) throw new Error("PIN must be 4–8 digits");
      this.db.prepare("UPDATE users SET pin = ?, updatedAt = ? WHERE id = ?").run(bcrypt.hashSync(input.pin, 10), now, id);
    }
    if (input.name !== undefined) {
      this.db.prepare("UPDATE users SET name = ?, updatedAt = ? WHERE id = ?").run(input.name.trim(), now, id);
    }
    if (input.role !== undefined) {
      this.db.prepare("UPDATE users SET role = ?, updatedAt = ? WHERE id = ?").run(input.role, now, id);
    }
    if (input.department !== undefined) {
      this.db.prepare("UPDATE users SET department = ?, updatedAt = ? WHERE id = ?").run(input.department, now, id);
    }
    if (input.isActive !== undefined) {
      this.db.prepare("UPDATE users SET isActive = ?, updatedAt = ? WHERE id = ?").run(input.isActive, now, id);
    }
    return this.getUser(id)!;
  }

  // ── Products ───────────────────────────────────────────────────────────────

  listProducts(): Product[] {
    return this.db
      .prepare("SELECT id, name, category, unitDefault, pricePerUnit, prepNotes, department, isActive, createdAt, updatedAt FROM products WHERE isActive = 1 ORDER BY category, name")
      .all() as Product[];
  }

  upsertProduct(input: ProductInput): Product {
    const now = new Date().toISOString();
    if (input.id) {
      this.db
        .prepare("UPDATE products SET name=?, category=?, unitDefault=?, pricePerUnit=?, prepNotes=?, department=?, updatedAt=? WHERE id=?")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, now, input.id);
      return this.db.prepare("SELECT * FROM products WHERE id = ?").get(input.id) as Product;
    } else {
      const result = this.db
        .prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, now, now);
      return this.db.prepare("SELECT * FROM products WHERE id = ?").get(Number(result.lastInsertRowid)) as Product;
    }
  }

  importProducts(rows: { name: string; category: string; unitDefault: string; pricePerUnit: string; prepNotes: string; department: string }[]): { imported: number; errors: string[] } {
    const now = new Date().toISOString();
    let imported = 0;
    const errors: string[] = [];
    const upsert = this.db.transaction(() => {
      for (const [i, row] of rows.entries()) {
        const name = row.name?.trim();
        if (!name) { errors.push(`Row ${i + 2}: name is required`); continue; }
        const category = row.category?.trim() || "General";
        const unitDefault = ["kg", "each", "g", "pack"].includes(row.unitDefault) ? row.unitDefault : "kg";
        const price = row.pricePerUnit ? parseFloat(row.pricePerUnit) : null;
        const dept = row.department === "kitchen" ? "kitchen" : "counter";
        const prepNotes = row.prepNotes?.trim() || "";
        const existing = this.db.prepare("SELECT id FROM products WHERE lower(name) = lower(?) AND isActive = 1").get(name) as { id: number } | null;
        if (existing) {
          this.db.prepare("UPDATE products SET category=?, unitDefault=?, pricePerUnit=?, prepNotes=?, department=?, updatedAt=? WHERE id=?")
            .run(category, unitDefault, price, prepNotes, dept, now, existing.id);
        } else {
          this.db.prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
            .run(name, category, unitDefault, price, prepNotes, dept, now, now);
        }
        imported++;
      }
    });
    upsert();
    return { imported, errors };
  }

  exportProducts(): string {
    const products = this.db
      .prepare("SELECT name, category, unitDefault, pricePerUnit, prepNotes, department FROM products WHERE isActive = 1 ORDER BY category, name")
      .all() as { name: string; category: string; unitDefault: string; pricePerUnit: number | null; prepNotes: string; department: string }[];
    const header = "name,category,unitDefault,pricePerUnit,prepNotes,department";
    const rows = products.map((p) => [p.name, p.category, p.unitDefault, p.pricePerUnit ?? "", p.prepNotes, p.department]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","));
    return [header, ...rows].join("\n");
  }

  exportBackup(): object {
    const products = this.db.prepare("SELECT * FROM products WHERE isActive = 1").all();
    const users = this.db.prepare("SELECT id, name, pin, role, department, isActive, createdAt FROM users").all();
    const orders = this.db.prepare("SELECT * FROM orders ORDER BY createdAt ASC").all();
    const orderItems = this.db.prepare("SELECT * FROM order_items").all();
    const settings = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      products,
      users,
      orders,
      orderItems,
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value]))
    };
  }

  importBackup(data: Record<string, unknown>): { products: number; users: number; orders: number } {
    if (!data.version || !Array.isArray(data.products)) throw new Error("Invalid backup file");
    const products = data.products as Record<string, unknown>[];
    const users = (data.users as Record<string, unknown>[]) ?? [];
    const orders = (data.orders as Record<string, unknown>[]) ?? [];
    const orderItems = (data.orderItems as Record<string, unknown>[]) ?? [];
    const settings = (data.settings as Record<string, string>) ?? {};

    // FK must be disabled outside transactions in SQLite
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec("DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM users;");
        for (const u of users) {
          this.db.prepare("INSERT INTO users (id,name,pin,role,department,isActive,createdAt) VALUES (?,?,?,?,?,?,?)")
            .run(u.id ?? null, u.name, u.pin, u.role, u.department ?? null, u.isActive ?? 1, u.createdAt);
        }
        const now = new Date().toISOString();
        for (const p of products) {
          this.db.prepare("INSERT INTO products (id,name,category,unitDefault,pricePerUnit,prepNotes,department,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,1,?,?)")
            .run(p.id ?? null, p.name, p.category, p.unitDefault, p.pricePerUnit ?? null, p.prepNotes, p.department, p.createdAt ?? now, p.updatedAt ?? now);
        }
        const insOrder = this.db.prepare("INSERT INTO orders (id,ticketNumber,customerName,customerPhone,orderType,deliveryAddress,requestedTime,assignedTo,status,kitchenStatus,counterStatus,requestedById,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const o of orders) insOrder.run(o.id,o.ticketNumber,o.customerName,o.customerPhone,o.orderType,o.deliveryAddress,o.requestedTime,o.assignedTo??null,o.status,o.kitchenStatus,o.counterStatus,o.requestedById??null,o.createdAt,o.updatedAt);
        const insItem = this.db.prepare("INSERT INTO order_items (id,orderId,productId,name,kg,quantity,notes,unitPrice,lineTotal,department) VALUES (?,?,?,?,?,?,?,?,?,?)");
        for (const i of orderItems) insItem.run(i.id,i.orderId,i.productId??null,i.name,i.kg??null,i.quantity??null,i.notes,i.unitPrice??null,i.lineTotal??null,i.department);
        for (const [key, value] of Object.entries(settings)) {
          this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
        }
      })();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    return { products: products.length, users: users.length, orders: orders.length };
  }

  deleteProduct(id: number): void {
    this.db.prepare("UPDATE products SET isActive = 0, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  createOrder(input: CreateOrderInput, requestedById: number): Order {
    const now = new Date().toISOString();
    const ticketNumber = this.nextTicketNumber();
    const hasKitchen = input.items.some((i) => i.department === "kitchen");
    const hasCounter = input.items.some((i) => i.department === "counter");
    const kitchenStatus: DeptStatus = hasKitchen ? "New" : "n/a";
    const counterStatus: DeptStatus = hasCounter ? "New" : "n/a";

    const result = this.db
      .prepare("INSERT INTO orders (ticketNumber, customerName, customerPhone, orderType, deliveryAddress, requestedTime, assignedTo, status, kitchenStatus, counterStatus, requestedById, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?)")
      .run(ticketNumber, input.customerName.trim(), input.customerPhone.trim(), input.orderType, input.orderType === "delivery" ? JSON.stringify(input.deliveryAddress) : "{}", input.requestedTime.trim(), input.assignedTo?.trim() || null, kitchenStatus, counterStatus, requestedById, now, now);

    const orderId = Number(result.lastInsertRowid);
    const insertItem = this.db.prepare(
      "INSERT INTO order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of input.items) {
      insertItem.run(orderId, item.productId ?? null, item.name.trim(), item.kg ?? null, item.quantity ?? null, item.notes.trim(), item.unitPrice ?? null, item.lineTotal ?? null, item.department);
    }
    return this.getOrder(orderId);
  }

  listOrders(scope: "active" | "history" | "all", department?: Department | null, limit = 50): Order[] {
    // Single JOIN query — avoids N+1 (one query per order for items)
    const base = `
      SELECT o.id, o.ticketNumber, o.customerName, o.customerPhone, o.orderType,
             o.deliveryAddress, o.requestedTime, o.assignedTo, o.status, o.kitchenStatus, o.counterStatus,
             o.requestedById, o.createdAt, o.updatedAt, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.department as oi_dept
      FROM orders o
      LEFT JOIN users u ON o.requestedById = u.id
      LEFT JOIN order_items oi ON o.id = oi.orderId`;

    let sql: string;
    let params: unknown[] = [];
    if (scope === "active") {
      sql = `${base} WHERE o.status IN ('New','Received','Ready') ORDER BY o.createdAt ASC`;
    } else if (scope === "history") {
      const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'historyDays'").get() as { value: string } | null;
      const days = Math.max(1, Number(setting?.value ?? 30));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      sql = `${base} WHERE o.status = 'Done' AND o.updatedAt >= ? ORDER BY o.updatedAt DESC LIMIT ${limit * 20}`;
      params = [since];
    } else {
      sql = `${base} ORDER BY o.createdAt DESC LIMIT ${limit * 20}`;
    }

    const allRows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const orderMap = this.buildOrderMap(allRows, scope !== "active" ? limit : undefined);

    let orders = Array.from(orderMap.values());
    if (department) {
      orders = orders.filter((o) => (department === "kitchen" ? o.kitchenStatus : o.counterStatus) !== "n/a");
    }
    return orders;
  }

  listOrdersInRange(from: string, to: string): Order[] {
    const sql = `
      SELECT o.id, o.ticketNumber, o.customerName, o.customerPhone, o.orderType,
             o.deliveryAddress, o.requestedTime, o.assignedTo, o.status, o.kitchenStatus, o.counterStatus,
             o.requestedById, o.createdAt, o.updatedAt, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.department as oi_dept
      FROM orders o
      LEFT JOIN users u ON o.requestedById = u.id
      LEFT JOIN order_items oi ON o.id = oi.orderId
      WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
      ORDER BY o.createdAt ASC
      LIMIT 100000`;

    return Array.from(this.buildOrderMap(this.db.prepare(sql).all(from, to) as Record<string, unknown>[]).values());
  }

  getOrder(id: number): Order {
    const order = this.db
      .prepare("SELECT o.*, u.name as requestedByName FROM orders o LEFT JOIN users u ON o.requestedById = u.id WHERE o.id = ?")
      .get(id) as Order | null;
    if (!order) throw new Error(`Order ${id} not found`);
    return { ...this.parseOrder(order), items: this.listOrderItems(id) };
  }

  updateOrderStatus(id: number, status: OrderStatus): Order {
    this.db.prepare("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.getOrder(id);
  }

  updateDeptStatus(id: number, department: Department, status: DeptStatus): Order {
    if (department !== "kitchen" && department !== "counter") throw new Error("Invalid department");
    const now = new Date().toISOString();
    if (department === "kitchen") {
      this.db.prepare("UPDATE orders SET kitchenStatus = ?, updatedAt = ? WHERE id = ?").run(status, now, id);
    } else {
      this.db.prepare("UPDATE orders SET counterStatus = ?, updatedAt = ? WHERE id = ?").run(status, now, id);
    }

    // Resolve overall status from both department statuses
    const row = this.db.prepare("SELECT kitchenStatus, counterStatus FROM orders WHERE id = ?").get(id) as { kitchenStatus: string; counterStatus: string };
    const active = [row.kitchenStatus, row.counterStatus].filter((s) => s !== "n/a");
    let overall: OrderStatus = "New";
    if (active.every((s) => s === "Done")) overall = "Done";
    else if (active.some((s) => s === "Ready" || s === "Done")) overall = "Ready";
    else if (active.some((s) => s === "Received")) overall = "Received";
    this.db.prepare("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?").run(overall, now, id);

    return this.getOrder(id);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildOrderMap(rows: Record<string, unknown>[], limit?: number): Map<number, Order> {
    const map = new Map<number, Order>();
    for (const row of rows) {
      const id = row.id as number;
      if (!map.has(id)) {
        if (limit !== undefined && map.size >= limit) break;
        const order = this.parseOrder(row as Order & { deliveryAddress: string });
        order.items = [];
        map.set(id, order);
      }
      if (row.oi_id != null) {
        map.get(id)!.items.push({
          id: row.oi_id as number,
          orderId: id,
          productId: row.oi_productId as number | null,
          name: row.oi_name as string,
          kg: row.oi_kg as number | null,
          quantity: row.oi_quantity as number | null,
          notes: row.oi_notes as string,
          unitPrice: row.oi_unitPrice as number | null,
          lineTotal: row.oi_lineTotal as number | null,
          department: row.oi_dept as Department,
        });
      }
    }
    return map;
  }

  private parseOrder(raw: Order & { deliveryAddress: string }): Order {
    let deliveryAddress: DeliveryAddress = { street: "", area: "", buildingType: "", apartment: "" };
    try { deliveryAddress = JSON.parse(raw.deliveryAddress as unknown as string) as DeliveryAddress; } catch { /* old or empty */ }
    return { ...raw, deliveryAddress };
  }

  private listOrderItems(orderId: number): OrderItem[] {
    return this.db
      .prepare("SELECT id, orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, department FROM order_items WHERE orderId = ? ORDER BY id ASC")
      .all(orderId) as OrderItem[];
  }

  private nextTicketNumber(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const prefix = `${stamp}-`;
    const row = this.db.prepare("SELECT ticketNumber FROM orders WHERE ticketNumber LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`) as { ticketNumber: string } | null;
    const next = row ? Number(row.ticketNumber.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
  }

  private migrate() {
    // One-time migration: "staff" role was split into "cashier" / "counter" / "kitchen"
    const hasStaff = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='users'").get() as { n: number }).n > 0
      && (this.db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'staff'").get() as { n: number }).n > 0;
    if (hasStaff) {
      this.db.prepare("UPDATE users SET role = 'cashier', department = NULL WHERE role = 'staff' AND lower(name) LIKE '%cashier%'").run();
      this.db.prepare("UPDATE users SET role = 'counter', department = 'counter' WHERE role = 'staff'").run();
    }

    // Add columns to users if missing
    if ((this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='users'").get() as { n: number }).n > 0) {
      const userCols = (this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
      if (!userCols.includes("lastSeenAt")) this.db.exec("ALTER TABLE users ADD COLUMN lastSeenAt TEXT");
    }

    // Add columns to orders if missing (existing databases)
    const ordersExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='orders'").get() as { n: number }).n > 0;
    if (ordersExists) {
      const cols = (this.db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("orderType")) this.db.exec("ALTER TABLE orders ADD COLUMN orderType TEXT NOT NULL DEFAULT 'pickup'");
      if (!cols.includes("deliveryAddress")) this.db.exec("ALTER TABLE orders ADD COLUMN deliveryAddress TEXT NOT NULL DEFAULT '{}'");
      if (!cols.includes("requestedTime")) this.db.exec("ALTER TABLE orders ADD COLUMN requestedTime TEXT NOT NULL DEFAULT ''");
      if (!cols.includes("assignedTo")) this.db.exec("ALTER TABLE orders ADD COLUMN assignedTo TEXT");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        pin TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        department TEXT,
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        unitDefault TEXT NOT NULL DEFAULT 'kg',
        pricePerUnit REAL,
        prepNotes TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT 'counter',
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketNumber TEXT NOT NULL UNIQUE,
        customerName TEXT NOT NULL,
        customerPhone TEXT NOT NULL,
        orderType TEXT NOT NULL DEFAULT 'pickup',
        deliveryAddress TEXT NOT NULL DEFAULT '{}',
        requestedTime TEXT NOT NULL DEFAULT '',
        assignedTo TEXT,
        status TEXT NOT NULL DEFAULT 'New',
        kitchenStatus TEXT NOT NULL DEFAULT 'n/a',
        counterStatus TEXT NOT NULL DEFAULT 'n/a',
        requestedById INTEGER REFERENCES users(id),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        productId INTEGER REFERENCES products(id),
        name TEXT NOT NULL,
        kg REAL,
        quantity INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        unitPrice REAL,
        lineTotal REAL,
        department TEXT NOT NULL DEFAULT 'counter'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oi_orderId    ON order_items(orderId);
      CREATE INDEX IF NOT EXISTS idx_ord_status    ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_ord_updatedAt ON orders(updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_usr_name      ON users(name COLLATE NOCASE);
    `);

    // Seed default settings
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('autoPrint', 'false')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('printStyle', 'thermal')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchenPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('counterPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('masterPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('historyDays', '30')").run();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  private seed() {
    const { count } = this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    if (count > 0) return;

    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO users (name, pin, role, department, isActive, createdAt) VALUES (?, ?, 'admin', NULL, 1, ?)").run("Admin", bcrypt.hashSync("0000", 10), now);

    const ins = this.db.prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, isActive, createdAt, updatedAt) VALUES (?, ?, 'kg', 0, ?, ?, 1, ?, ?)");
    for (const [name, category, prepNotes, dept] of [
      ["Beef Mince",       "Beef",    "Pack fresh",                  "counter"],
      ["Rump Steak",       "Beef",    "Cut to requested thickness",  "counter"],
      ["Boerewors",        "Sausage", "Coil and pack",               "counter"],
      ["Lamb Chops",       "Lamb",    "Trim excess fat",             "counter"],
      ["Chicken Fillets",  "Poultry", "Skinless",                    "counter"],
      ["Roast Chicken",    "Poultry", "Full roast",                  "kitchen"],
      ["Chicken Wings",    "Poultry", "Crispy fried",                "kitchen"],
    ]) {
      ins.run(name, category, prepNotes, dept, now, now);
    }
  }
}
