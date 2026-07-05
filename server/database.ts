// SQLite data access layer. One class wraps the whole schema — every query
// the server needs lives here, grouped by domain (users/products/suppliers/
// weigh-ins/orders/settings) with `migrate()` handling both fresh installs
// (CREATE TABLE IF NOT EXISTS) and upgrading existing databases in place
// (guarded ALTER TABLE, checked via PRAGMA table_info before running).
import BetterSqlite3 from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import type {
  Product, ProductInput, QuickCreateProductInput,
  Order, OrderItem, OrderItemInput, CreateOrderInput, OrderStatus,
  User, UserInput,
  Department, DeptStatus, DeliveryAddress,
  Supplier, WeighInBatch, WeighInBatchSummary, WeighInLine, WeighInLineInput,
  StockLocation, ProductStockRow, ItemSalesStat, ItemStockMovementStat, StatisticsOverview
} from "../src/shared/types.js";

export class KotDatabase {
  private db!: BetterSqlite3.Database;

  // Opens (or creates) the SQLite file under DATA_DIR, then brings the
  // schema up to date and seeds default data on a first run.
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
      .prepare("SELECT id, name, role, department, isActive, createdAt, lastSeenAt, themeMode FROM users ORDER BY name")
      .all() as User[];
  }

  touchLastSeen(id: number): void {
    this.db.prepare("UPDATE users SET lastSeenAt = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  getUser(id: number): User | null {
    return this.db
      .prepare("SELECT id, name, role, department, isActive, createdAt, themeMode FROM users WHERE id = ?")
      .get(id) as User | null;
  }

  getUserByName(name: string): (User & { pin: string }) | null {
    return this.db
      .prepare("SELECT id, name, pin, role, department, isActive, createdAt, themeMode FROM users WHERE lower(name) = lower(?) AND isActive = 1")
      .get(name) as (User & { pin: string }) | null;
  }

  // Re-confirms the currently logged-in user's own PIN (e.g. before an
  // accidental-tap-prone action like removing a POS line) without issuing
  // a new token or touching the session — just a yes/no on "is this really
  // them." isActive is intentionally not required here: unlike login, a
  // user who's mid-shift shouldn't get locked out of confirming an action
  // because someone else deactivated their account moments earlier.
  verifyUserPin(id: number, pin: string): boolean {
    const row = this.db.prepare("SELECT pin FROM users WHERE id = ?").get(id) as { pin: string } | null;
    return !!row && bcrypt.compareSync(String(pin), row.pin);
  }

  setUserThemeMode(id: number, themeMode: "light" | "dark"): User {
    this.db.prepare("UPDATE users SET themeMode = ? WHERE id = ?").run(themeMode, id);
    return this.getUser(id)!;
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
  // onHandQty is derived (SUM across every location in product_stock), not a
  // column anyone writes to directly — see the "Stock locations" section
  // below for where the real per-location numbers live and how they change.
  // Product.lastCountedAt/lastCountedById are legacy (pre-dating per-location
  // tracking) and no longer updated; the authoritative per-location count
  // timestamp/user lives on each product_stock row instead.

  listProducts(): Product[] {
    return this.db
      .prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.isRawIntake, p.createdAt, p.updatedAt
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id
        WHERE p.isActive = 1
        GROUP BY p.id
        ORDER BY p.category, p.name`)
      .all() as Product[];
  }

  getProductByBarcode(barcode: string): Product | null {
    return this.db.prepare("SELECT * FROM products WHERE barcode = ? AND isActive = 1").get(barcode) as Product | null;
  }

  upsertProduct(input: ProductInput): Product {
    const now = new Date().toISOString();
    const barcode = input.barcode?.trim() || null;
    const isRawIntake = input.isRawIntake ? 1 : 0;
    if (input.id) {
      this.db
        .prepare("UPDATE products SET name=?, category=?, unitDefault=?, pricePerUnit=?, prepNotes=?, department=?, lowStockThreshold=?, barcode=?, isRawIntake=?, updatedAt=? WHERE id=?")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, input.lowStockThreshold ?? null, barcode, isRawIntake, now, input.id);
      return this.db.prepare("SELECT * FROM products WHERE id = ?").get(input.id) as Product;
    } else {
      const result = this.db
        .prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, lowStockThreshold, barcode, isRawIntake, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, input.lowStockThreshold ?? null, barcode, isRawIntake, now, now);
      return this.db.prepare("SELECT * FROM products WHERE id = ?").get(Number(result.lastInsertRowid)) as Product;
    }
  }

  // Minimal product creation from an unrecognized barcode scan at the
  // register — everything but name/barcode/price/department defaults
  // sensibly (same defaults as CSV import), so a cashier can add a new
  // item in one step without needing full admin product-management access.
  quickCreateProductByBarcode(input: QuickCreateProductInput): Product {
    const barcode = input.barcode.trim();
    if (!barcode) throw new Error("Barcode is required");
    const name = input.name.trim();
    if (!name) throw new Error("Name is required");
    if (this.getProductByBarcode(barcode)) throw new Error("A product with this barcode already exists");
    return this.upsertProduct({
      name,
      category: "General",
      unitDefault: "kg",
      pricePerUnit: input.pricePerUnit,
      prepNotes: "",
      department: input.department,
      lowStockThreshold: null,
      barcode
    });
  }

  listLowStock(): Product[] {
    return this.db
      .prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.isRawIntake, p.createdAt, p.updatedAt
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id
        WHERE p.isActive = 1 AND p.lowStockThreshold IS NOT NULL
        GROUP BY p.id
        HAVING onHandQty <= p.lowStockThreshold
        ORDER BY p.name`)
      .all() as Product[];
  }

  // ── Stock locations ────────────────────────────────────────────────────────
  // Physical places stock sits (Cold Room, Counter, ...). Every product's
  // stock is tracked per location — nobody edits a location's quantity
  // directly; recordStockCount() below is the only write path, and it always
  // computes the change from a physically-observed count rather than
  // accepting an arbitrary "new total" from the client.

  listStockLocations(): StockLocation[] {
    return this.db.prepare("SELECT * FROM stock_locations WHERE isActive = 1 ORDER BY name").all() as StockLocation[];
  }

  createStockLocation(name: string): StockLocation {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Location name is required");
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO stock_locations (name, isActive, createdAt) VALUES (?, 1, ?)").run(trimmed, now);
    return this.db.prepare("SELECT * FROM stock_locations WHERE name = ? COLLATE NOCASE").get(trimmed) as StockLocation;
  }

  deactivateStockLocation(id: number): void {
    this.db.prepare("UPDATE stock_locations SET isActive = 0 WHERE id = ?").run(id);
  }

  // Every active product's quantity at one location — a LEFT JOIN so a
  // product with no product_stock row yet (never counted here) still shows
  // up with qty 0, rather than being missing from the list entirely.
  listProductStockForLocation(locationId: number): ProductStockRow[] {
    return this.db
      .prepare(`
        SELECT p.id as productId, p.name as productName, p.category, ? as locationId,
               COALESCE(ps.qty, 0) as qty, ps.lastCountedAt, ps.lastCountedById, u.name as lastCountedByName
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id AND ps.locationId = ?
        LEFT JOIN users u ON ps.lastCountedById = u.id
        WHERE p.isActive = 1
        ORDER BY p.category, p.name`)
      .all(locationId, locationId) as ProductStockRow[];
  }

  private getProductStockRow(productId: number, locationId: number): ProductStockRow {
    return this.db
      .prepare(`
        SELECT p.id as productId, p.name as productName, p.category, ps.locationId,
               ps.qty, ps.lastCountedAt, ps.lastCountedById, u.name as lastCountedByName
        FROM product_stock ps
        JOIN products p ON p.id = ps.productId
        LEFT JOIN users u ON ps.lastCountedById = u.id
        WHERE ps.productId = ? AND ps.locationId = ?`)
      .get(productId, locationId) as ProductStockRow;
  }

  // Applies a relative change to one product's quantity at one location
  // (e.g. +pieces from a weigh-in line, or the negative of that when a line
  // is edited/deleted). Clamped at 0. This is the low-level primitive —
  // recordStockCount below is what the Stock Take screen actually calls.
  adjustProductStock(productId: number, locationId: number, delta: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO product_stock (productId, locationId, qty, updatedAt) VALUES (?, ?, MAX(0, ?), ?)
        ON CONFLICT(productId, locationId) DO UPDATE SET qty = MAX(0, product_stock.qty + ?), updatedAt = ?`)
      .run(productId, locationId, delta, now, delta, now);
  }

  // The only way stock at a location actually changes from the Stock Take
  // screen: given what someone physically counted, compute the delta from
  // the current stored quantity and apply it — same as any other
  // adjustment, just derived from an observation instead of typed directly.
  // Available to every role that can access Stock Take (including admin —
  // there's deliberately no separate "just set it to X" path for anyone).
  recordStockCount(productId: number, locationId: number, countedQty: number, countedById: number): ProductStockRow {
    if (countedQty < 0) throw new Error("Counted quantity can't be negative");
    const now = new Date().toISOString();
    const current = this.getProductStockRow(productId, locationId);
    const delta = countedQty - (current?.qty ?? 0);
    this.db
      .prepare(`
        INSERT INTO product_stock (productId, locationId, qty, lastCountedAt, lastCountedById, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(productId, locationId) DO UPDATE SET qty = product_stock.qty + ?, lastCountedAt = ?, lastCountedById = ?, updatedAt = ?`)
      .run(productId, locationId, Math.max(0, countedQty), now, countedById, now, delta, now, countedById, now);
    return this.getProductStockRow(productId, locationId);
  }

  // ── Suppliers ──────────────────────────────────────────────────────────────

  listSuppliers(): Supplier[] {
    return this.db.prepare("SELECT * FROM suppliers WHERE isActive = 1 ORDER BY name").all() as Supplier[];
  }

  createSupplier(name: string): Supplier {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Supplier name is required");
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO suppliers (name, isActive, createdAt) VALUES (?, 1, ?)").run(trimmed, now);
    return this.db.prepare("SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE").get(trimmed) as Supplier;
  }

  // ── Weigh-in batches ───────────────────────────────────────────────────────
  // A batch groups the lines logged in one stock-taking session. At most one
  // batch is "open" at a time (auto-created by addWeighInLine on first use);
  // finalizing it locks all its lines against further edits/deletes.

  private batchRow(id: number): WeighInBatch {
    return this.db
      .prepare("SELECT b.*, u.name as createdByName FROM weigh_in_batches b LEFT JOIN users u ON b.createdById = u.id WHERE b.id = ?")
      .get(id) as WeighInBatch;
  }

  getOpenBatch(): WeighInBatch | null {
    const row = this.db.prepare("SELECT id FROM weigh_in_batches WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
    return row ? this.batchRow(row.id) : null;
  }

  getBatch(id: number): WeighInBatch {
    const batch = this.batchRow(id);
    if (!batch) throw new Error(`Batch ${id} not found`);
    return batch;
  }

  createBatch(createdById: number): WeighInBatch {
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO weigh_in_batches (status, createdById, createdAt) VALUES ('open', ?, ?)").run(createdById, now);
    return this.batchRow(Number(result.lastInsertRowid));
  }

  finalizeBatch(id: number): WeighInBatch {
    const batch = this.getBatch(id);
    if (batch.status === "finalized") throw new Error("Batch already finalized");
    this.db.prepare("UPDATE weigh_in_batches SET status = 'finalized', finalizedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.getBatch(id);
  }

  // Adds one line to the open batch, auto-opening a new batch if none is
  // in progress. Wrapped in a transaction so the line insert and the stock
  // adjustment it triggers either both happen or neither does.
  addWeighInLine(input: WeighInLineInput, createdById: number): WeighInLine {
    const add = this.db.transaction(() => {
      const batch = this.getOpenBatch() ?? this.createBatch(createdById);
      const now = new Date().toISOString();
      const result = this.db
        .prepare("INSERT INTO weigh_in_lines (batchId, productId, grade, piecesReceived, weightKg, supplierId, locationId, createdById, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(batch.id, input.productId, input.grade, input.piecesReceived, input.weightKg, input.supplierId, input.locationId, createdById, now);
      this.adjustProductStock(input.productId, input.locationId, input.piecesReceived);
      return Number(result.lastInsertRowid);
    });
    const id = add();
    return this.db
      .prepare(`SELECT l.*, p.name as productName, s.name as supplierName, loc.name as locationName, u.name as createdByName
                FROM weigh_in_lines l
                LEFT JOIN products p ON l.productId = p.id
                LEFT JOIN suppliers s ON l.supplierId = s.id
                LEFT JOIN stock_locations loc ON l.locationId = loc.id
                LEFT JOIN users u ON l.createdById = u.id
                WHERE l.id = ?`)
      .get(id) as WeighInLine;
  }

  // Edits an existing line (only while its batch is still open). Stock is
  // reconciled by reversing the old delta at its old location, then applying
  // the new one at the (possibly different) new location — correctly
  // handles a product/location/pieces change in one step without needing a
  // separate "diff" calculation.
  updateWeighInLine(id: number, input: WeighInLineInput): WeighInLine {
    const update = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT l.*, b.status as batchStatus FROM weigh_in_lines l JOIN weigh_in_batches b ON l.batchId = b.id WHERE l.id = ?")
        .get(id) as (WeighInLine & { batchStatus: string }) | null;
      if (!existing) throw new Error(`Weigh-in line ${id} not found`);
      if (existing.batchStatus !== "open") throw new Error("Cannot edit a line in a finalized batch");

      // Reverse the old line's stock impact, then apply the new one — handles product/location changes too
      this.adjustProductStock(existing.productId, existing.locationId, -existing.piecesReceived);
      this.adjustProductStock(input.productId, input.locationId, input.piecesReceived);

      this.db
        .prepare("UPDATE weigh_in_lines SET productId=?, grade=?, piecesReceived=?, weightKg=?, supplierId=?, locationId=? WHERE id=?")
        .run(input.productId, input.grade, input.piecesReceived, input.weightKg, input.supplierId, input.locationId, id);
    });
    update();
    return this.db
      .prepare(`SELECT l.*, p.name as productName, s.name as supplierName, loc.name as locationName, u.name as createdByName
                FROM weigh_in_lines l
                LEFT JOIN products p ON l.productId = p.id
                LEFT JOIN suppliers s ON l.supplierId = s.id
                LEFT JOIN stock_locations loc ON l.locationId = loc.id
                LEFT JOIN users u ON l.createdById = u.id
                WHERE l.id = ?`)
      .get(id) as WeighInLine;
  }

  // Removes a line and reverses its stock impact (only while its batch is open).
  deleteWeighInLine(id: number): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT l.*, b.status as batchStatus FROM weigh_in_lines l JOIN weigh_in_batches b ON l.batchId = b.id WHERE l.id = ?")
        .get(id) as (WeighInLine & { batchStatus: string }) | null;
      if (!existing) throw new Error(`Weigh-in line ${id} not found`);
      if (existing.batchStatus !== "open") throw new Error("Cannot delete a line in a finalized batch");

      this.adjustProductStock(existing.productId, existing.locationId, -existing.piecesReceived);
      this.db.prepare("DELETE FROM weigh_in_lines WHERE id = ?").run(id);
    })();
  }

  // With a batchId: every line in that batch, oldest first (matches entry order).
  // Without one: most recent lines across all batches, for general auditing.
  listWeighInLines(batchId?: number, limit = 500): WeighInLine[] {
    const base = `SELECT l.*, p.name as productName, s.name as supplierName, loc.name as locationName, u.name as createdByName
                  FROM weigh_in_lines l
                  LEFT JOIN products p ON l.productId = p.id
                  LEFT JOIN suppliers s ON l.supplierId = s.id
                  LEFT JOIN stock_locations loc ON l.locationId = loc.id
                  LEFT JOIN users u ON l.createdById = u.id`;
    if (batchId != null) {
      return this.db.prepare(`${base} WHERE l.batchId = ? ORDER BY l.createdAt ASC`).all(batchId) as WeighInLine[];
    }
    return this.db.prepare(`${base} ORDER BY l.createdAt DESC LIMIT ?`).all(limit) as WeighInLine[];
  }

  // Finalized batches with aggregated totals per batch (line count, total
  // pieces/kg, and a comma list of the suppliers/products involved) — the
  // dataset behind the admin history panel and its date-range filter.
  listFinalizedBatches(from?: string, to?: string): WeighInBatchSummary[] {
    const where = from && to ? "WHERE b.status = 'finalized' AND substr(b.finalizedAt, 1, 10) >= ? AND substr(b.finalizedAt, 1, 10) <= ?" : "WHERE b.status = 'finalized'";
    const sql = `
      SELECT b.*, u.name as createdByName,
             COUNT(l.id) as lineCount,
             COALESCE(SUM(l.piecesReceived), 0) as totalPieces,
             COALESCE(SUM(l.weightKg), 0) as totalKg,
             GROUP_CONCAT(DISTINCT s.name) as supplierNames,
             GROUP_CONCAT(DISTINCT p.name) as productNames
      FROM weigh_in_batches b
      LEFT JOIN users u ON b.createdById = u.id
      LEFT JOIN weigh_in_lines l ON l.batchId = b.id
      LEFT JOIN suppliers s ON l.supplierId = s.id
      LEFT JOIN products p ON l.productId = p.id
      ${where}
      GROUP BY b.id
      ORDER BY b.finalizedAt DESC`;
    const params = from && to ? [from, to] : [];
    return this.db.prepare(sql).all(...params) as WeighInBatchSummary[];
  }

  // Upserts products by case-insensitive name match (existing products are
  // updated in place rather than duplicated) from parsed CSV rows.
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

  // Snapshots every table into one plain object for the admin's downloadable
  // backup file. Kept in sync with importBackup below — any new table added
  // to the schema needs to be added to both.
  exportBackup(): object {
    const products = this.db.prepare("SELECT * FROM products WHERE isActive = 1").all();
    const users = this.db.prepare("SELECT id, name, pin, role, department, isActive, createdAt FROM users").all();
    const orders = this.db.prepare("SELECT * FROM orders ORDER BY createdAt ASC").all();
    const orderItems = this.db.prepare("SELECT * FROM order_items").all();
    const suppliers = this.db.prepare("SELECT * FROM suppliers").all();
    const weighInBatches = this.db.prepare("SELECT * FROM weigh_in_batches").all();
    const weighInLines = this.db.prepare("SELECT * FROM weigh_in_lines").all();
    const stockLocations = this.db.prepare("SELECT * FROM stock_locations").all();
    const productStock = this.db.prepare("SELECT * FROM product_stock").all();
    const settings = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      products,
      users,
      orders,
      orderItems,
      suppliers,
      weighInBatches,
      weighInLines,
      stockLocations,
      productStock,
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value]))
    };
  }

  // Wipes and replaces every table from a backup file, preserving original
  // row IDs (so foreign keys between orders/order_items etc. stay valid).
  // Runs with foreign_keys temporarily OFF because SQLite requires that
  // outside of a transaction, and a mid-restore state would otherwise
  // violate FK constraints (e.g. order_items inserted before their order).
  importBackup(data: Record<string, unknown>): { products: number; users: number; orders: number } {
    if (!data.version || !Array.isArray(data.products)) throw new Error("Invalid backup file");
    const products = data.products as Record<string, unknown>[];
    const users = (data.users as Record<string, unknown>[]) ?? [];
    const orders = (data.orders as Record<string, unknown>[]) ?? [];
    const orderItems = (data.orderItems as Record<string, unknown>[]) ?? [];
    const suppliers = (data.suppliers as Record<string, unknown>[]) ?? [];
    const weighInBatches = (data.weighInBatches as Record<string, unknown>[]) ?? [];
    const weighInLines = (data.weighInLines as Record<string, unknown>[]) ?? [];
    const stockLocations = (data.stockLocations as Record<string, unknown>[]) ?? [];
    const productStock = (data.productStock as Record<string, unknown>[]) ?? [];
    const settings = (data.settings as Record<string, string>) ?? {};

    // FK must be disabled outside transactions in SQLite
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec("DELETE FROM product_stock; DELETE FROM stock_locations; DELETE FROM weigh_in_lines; DELETE FROM weigh_in_batches; DELETE FROM suppliers; DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM users;");
        for (const u of users) {
          this.db.prepare("INSERT INTO users (id,name,pin,role,department,isActive,createdAt) VALUES (?,?,?,?,?,?,?)")
            .run(u.id ?? null, u.name, u.pin, u.role, u.department ?? null, u.isActive ?? 1, u.createdAt);
        }
        const now = new Date().toISOString();
        for (const p of products) {
          this.db.prepare("INSERT INTO products (id,name,category,unitDefault,pricePerUnit,prepNotes,department,lowStockThreshold,onHandQty,lastCountedAt,lastCountedById,barcode,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
            .run(p.id ?? null, p.name, p.category, p.unitDefault, p.pricePerUnit ?? null, p.prepNotes, p.department, p.lowStockThreshold ?? null, p.onHandQty ?? 0, p.lastCountedAt ?? null, p.lastCountedById ?? null, p.barcode ?? null, p.createdAt ?? now, p.updatedAt ?? now);
        }
        const insOrder = this.db.prepare("INSERT INTO orders (id,ticketNumber,customerName,customerPhone,orderType,deliveryAddress,requestedTime,assignedTo,status,kitchenStatus,counterStatus,requestedById,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const o of orders) insOrder.run(o.id,o.ticketNumber,o.customerName,o.customerPhone,o.orderType,o.deliveryAddress,o.requestedTime,o.assignedTo??null,o.status,o.kitchenStatus,o.counterStatus,o.requestedById??null,o.createdAt,o.updatedAt);
        const insItem = this.db.prepare("INSERT INTO order_items (id,orderId,productId,name,kg,quantity,notes,unitPrice,lineTotal,wantedPrice,department) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
        for (const i of orderItems) insItem.run(i.id,i.orderId,i.productId??null,i.name,i.kg??null,i.quantity??null,i.notes,i.unitPrice??null,i.lineTotal??null,i.wantedPrice??null,i.department);
        const insSupplier = this.db.prepare("INSERT INTO suppliers (id,name,isActive,createdAt) VALUES (?,?,?,?)");
        for (const s of suppliers) insSupplier.run(s.id,s.name,s.isActive??1,s.createdAt);
        const insBatch = this.db.prepare("INSERT INTO weigh_in_batches (id,status,createdById,createdAt,finalizedAt) VALUES (?,?,?,?,?)");
        for (const b of weighInBatches) insBatch.run(b.id,b.status,b.createdById??null,b.createdAt,b.finalizedAt??null);
        const insLoc = this.db.prepare("INSERT INTO stock_locations (id,name,isActive,createdAt) VALUES (?,?,?,?)");
        for (const loc of stockLocations) insLoc.run(loc.id,loc.name,loc.isActive??1,loc.createdAt);
        const insLine = this.db.prepare("INSERT INTO weigh_in_lines (id,batchId,productId,grade,piecesReceived,weightKg,supplierId,locationId,createdById,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)");
        for (const l of weighInLines) insLine.run(l.id,l.batchId,l.productId,l.grade,l.piecesReceived,l.weightKg,l.supplierId??null,l.locationId??null,l.createdById??null,l.createdAt);
        const insPStock = this.db.prepare("INSERT INTO product_stock (productId,locationId,qty,lastCountedAt,lastCountedById,updatedAt) VALUES (?,?,?,?,?,?)");
        for (const ps of productStock) insPStock.run(ps.productId,ps.locationId,ps.qty??0,ps.lastCountedAt??null,ps.lastCountedById??null,ps.updatedAt??now);
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
    const doneNow = input.completeImmediately ?? false;
    const kitchenStatus: DeptStatus = hasKitchen ? (doneNow ? "Done" : "New") : "n/a";
    const counterStatus: DeptStatus = hasCounter ? (doneNow ? "Done" : "New") : "n/a";
    const overallStatus: OrderStatus = doneNow ? "Done" : "New";

    const result = this.db
      .prepare("INSERT INTO orders (ticketNumber, customerName, customerPhone, orderType, deliveryAddress, requestedTime, assignedTo, status, kitchenStatus, counterStatus, requestedById, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ticketNumber, input.customerName.trim(), input.customerPhone.trim(), input.orderType, input.orderType === "delivery" ? JSON.stringify(input.deliveryAddress) : "{}", input.requestedTime.trim(), input.assignedTo?.trim() || null, overallStatus, kitchenStatus, counterStatus, requestedById, now, now);

    const orderId = Number(result.lastInsertRowid);
    const insertItem = this.db.prepare(
      "INSERT INTO order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of input.items) {
      insertItem.run(orderId, item.productId ?? null, item.name.trim(), item.kg ?? null, item.quantity ?? null, item.notes.trim(), item.unitPrice ?? null, item.lineTotal ?? null, item.wantedPrice ?? null, item.department);
    }
    return this.getOrder(orderId);
  }

  // scope="active": open tickets (New/Received/Ready) for the live queue.
  // scope="history": completed tickets within the configurable retention
  //   window (settings.historyDays), newest first.
  // scope="all": everything, newest first — used by admin/reporting views.
  // `limit * 20` on the raw SQL fetches enough joined rows to cover `limit`
  // distinct orders even when some have many line items, before buildOrderMap
  // collapses rows into orders and caps at `limit`.
  listOrders(scope: "active" | "history" | "all", department?: Department | null, limit = 50): Order[] {
    // Single JOIN query — avoids N+1 (one query per order for items)
    const base = `
      SELECT o.id, o.ticketNumber, o.customerName, o.customerPhone, o.orderType,
             o.deliveryAddress, o.requestedTime, o.assignedTo, o.status, o.kitchenStatus, o.counterStatus,
             o.requestedById, o.createdAt, o.updatedAt, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.wantedPrice as oi_wantedPrice, oi.department as oi_dept
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
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.wantedPrice as oi_wantedPrice, oi.department as oi_dept
      FROM orders o
      LEFT JOIN users u ON o.requestedById = u.id
      LEFT JOIN order_items oi ON o.id = oi.orderId
      WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
      ORDER BY o.createdAt ASC
      LIMIT 100000`;

    return Array.from(this.buildOrderMap(this.db.prepare(sql).all(from, to) as Record<string, unknown>[]).values());
  }

  // Sales performance per item within a date range, for the admin
  // Statistics screen. Grouped by item name rather than productId, since
  // free-text order lines (no catalog product picked) never have one —
  // this way every item that's ever actually been sold shows up, not just
  // ones still in the catalog.
  salesByItem(from: string, to: string): ItemSalesStat[] {
    return this.db
      .prepare(`
        SELECT oi.name as name,
               COALESCE(SUM(oi.quantity), 0) as totalQty,
               COALESCE(SUM(oi.kg), 0) as totalKg,
               COALESCE(SUM(oi.lineTotal), 0) as totalRevenue,
               COUNT(DISTINCT oi.orderId) as orderCount
        FROM order_items oi
        JOIN orders o ON o.id = oi.orderId
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY lower(oi.name)
        ORDER BY totalRevenue DESC`)
      .all(from, to) as ItemSalesStat[];
  }

  // How much of each raw-intake item was received (Weigh-In) within a date
  // range, alongside its live current on-hand total — only raw-intake items
  // have anything to show here, since they're the only things Weigh-In ever
  // receives (see isRawIntake).
  stockMovementByItem(from: string, to: string): ItemStockMovementStat[] {
    return this.db
      .prepare(`
        SELECT p.id as productId, p.name as productName,
               COALESCE(SUM(wl.piecesReceived), 0) as totalPiecesReceived,
               COALESCE(SUM(wl.weightKg), 0) as totalKgReceived,
               COALESCE((SELECT SUM(qty) FROM product_stock ps WHERE ps.productId = p.id), 0) as currentOnHand,
               p.lowStockThreshold
        FROM products p
        LEFT JOIN weigh_in_lines wl ON wl.productId = p.id AND substr(wl.createdAt, 1, 10) >= ? AND substr(wl.createdAt, 1, 10) <= ?
        WHERE p.isActive = 1 AND p.isRawIntake = 1
        GROUP BY p.id
        ORDER BY totalKgReceived DESC`)
      .all(from, to) as ItemStockMovementStat[];
  }

  // Headline KPIs + breakdowns for the Statistics overview dashboard, plus
  // the immediately-preceding period of equal length (for %-change) so the
  // client doesn't need a second request just to compute deltas.
  statisticsOverview(from: string, to: string): StatisticsOverview {
    const totals = (f: string, t: string) => this.db
      .prepare(`
        SELECT COALESCE(SUM(oi.lineTotal), 0) as totalRevenue,
               COALESCE(SUM(oi.kg), 0) as totalKg,
               COALESCE(SUM(oi.quantity), 0) as totalQty,
               COUNT(DISTINCT oi.orderId) as totalOrders
        FROM order_items oi
        JOIN orders o ON o.id = oi.orderId
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?`)
      .get(f, t) as { totalRevenue: number; totalKg: number; totalQty: number; totalOrders: number };

    const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
    const shift = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
    const prevTo = shift(from, -1);
    const prevFrom = shift(prevTo, -(days - 1));

    const current = totals(from, to);
    const previous = totals(prevFrom, prevTo);

    const revenueByDay = this.db
      .prepare(`
        SELECT substr(o.createdAt, 1, 10) as date,
               COALESCE(SUM(oi.lineTotal), 0) as revenue,
               COUNT(DISTINCT o.id) as orders
        FROM orders o
        LEFT JOIN order_items oi ON oi.orderId = o.id
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY date ORDER BY date ASC`)
      .all(from, to) as { date: string; revenue: number; orders: number }[];

    const revenueByDept = this.db
      .prepare(`
        SELECT oi.department as department, COALESCE(SUM(oi.lineTotal), 0) as revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.orderId
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY oi.department`)
      .all(from, to) as { department: string; revenue: number }[];

    const revenueByOrderType = this.db
      .prepare(`
        SELECT o.orderType as orderType, COALESCE(SUM(oi.lineTotal), 0) as revenue
        FROM orders o
        LEFT JOIN order_items oi ON oi.orderId = o.id
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY o.orderType`)
      .all(from, to) as { orderType: string; revenue: number }[];

    const ordersByStatus = this.db
      .prepare(`
        SELECT status, COUNT(*) as count
        FROM orders
        WHERE substr(createdAt, 1, 10) >= ? AND substr(createdAt, 1, 10) <= ?
        GROUP BY status`)
      .all(from, to) as { status: string; count: number }[];

    return {
      totalRevenue: current.totalRevenue,
      totalOrders: current.totalOrders,
      avgOrderValue: current.totalOrders ? current.totalRevenue / current.totalOrders : 0,
      totalKg: current.totalKg,
      totalQty: current.totalQty,
      prevRevenue: previous.totalRevenue,
      prevOrders: previous.totalOrders,
      prevAvgOrderValue: previous.totalOrders ? previous.totalRevenue / previous.totalOrders : 0,
      revenueByDay, revenueByDept, revenueByOrderType, ordersByStatus
    };
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

  // Appends one item to an already-created order — used by the "Scan
  // barcode" button on an in-progress ticket (as opposed to items added
  // while first building the order in OrderEntry). Blocked once an order
  // is Done, same as editing anything else about a finished ticket.
  addOrderItem(orderId: number, item: OrderItemInput): Order {
    const order = this.getOrder(orderId);
    if (order.status === "Done") throw new Error("Cannot add items to a completed order");
    this.db
      .prepare("INSERT INTO order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(orderId, item.productId ?? null, item.name.trim(), item.kg ?? null, item.quantity ?? null, item.notes.trim(), item.unitPrice ?? null, item.lineTotal ?? null, item.wantedPrice ?? null, item.department);
    this.db.prepare("UPDATE orders SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), orderId);
    return this.getOrder(orderId);
  }

  // Updates one department's status, then recomputes the order's overall
  // status from both department statuses (an order with only kitchen items
  // has counterStatus="n/a", which is excluded from the "active" list below
  // so a department that was never involved can't block completion).
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

  // Collapses flat JOIN rows (one row per order_item, order fields repeated)
  // into a Map of orderId -> Order with a nested items array. Insertion
  // order into the Map matches the SQL's ORDER BY. Relies on all of one
  // order's item rows being contiguous (guaranteed by the ORDER BY on the
  // caller's SQL) so that once `limit` distinct orders have been seen, the
  // loop can stop immediately without truncating an order's item list mid-way.
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
          wantedPrice: row.oi_wantedPrice as number | null,
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
      .prepare("SELECT id, orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department FROM order_items WHERE orderId = ? ORDER BY id ASC")
      .all(orderId) as OrderItem[];
  }

  // Generates tickets like "20260701-001": a YYYYMMDD date stamp plus a
  // per-day sequence number, so numbering naturally resets each day.
  private nextTicketNumber(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const prefix = `${stamp}-`;
    const row = this.db.prepare("SELECT ticketNumber FROM orders WHERE ticketNumber LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`) as { ticketNumber: string } | null;
    const next = row ? Number(row.ticketNumber.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
  }

  // Brings the schema up to date on every startup. Runs in three phases:
  // (1) one-time data cleanups/migrations for features that changed shape,
  // (2) guarded ALTER TABLEs for columns added after a table already existed
  //     in the wild (checked via PRAGMA table_info so they only run once),
  // (3) CREATE TABLE IF NOT EXISTS for the full current schema, which is
  //     what a brand-new install actually runs. Phases 1–2 are no-ops on a
  //     fresh database since the tables/columns won't exist yet to check.
  private migrate() {
    // One-time cleanup: the old single-entry meat-weight-income feature was replaced
    // by the batch weigh-in workflow (suppliers/weigh_in_batches/weigh_in_lines below)
    this.db.exec("DROP TABLE IF EXISTS meat_weight_income");
    if ((this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='settings'").get() as { n: number }).n > 0) {
      this.db.prepare("DELETE FROM settings WHERE key IN ('meatWeightDefaultBeef', 'meatWeightDefaultLamb')").run();
    }

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
      if (!userCols.includes("themeMode")) this.db.exec("ALTER TABLE users ADD COLUMN themeMode TEXT");
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

    // Add stock-tracking columns to products if missing (existing databases)
    const productsExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='products'").get() as { n: number }).n > 0;
    if (productsExists) {
      const prodCols = (this.db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((c) => c.name);
      if (!prodCols.includes("lowStockThreshold")) this.db.exec("ALTER TABLE products ADD COLUMN lowStockThreshold REAL");
      if (!prodCols.includes("onHandQty")) this.db.exec("ALTER TABLE products ADD COLUMN onHandQty REAL NOT NULL DEFAULT 0");
      if (!prodCols.includes("lastCountedAt")) this.db.exec("ALTER TABLE products ADD COLUMN lastCountedAt TEXT");
      if (!prodCols.includes("lastCountedById")) this.db.exec("ALTER TABLE products ADD COLUMN lastCountedById INTEGER REFERENCES users(id)");
      if (!prodCols.includes("barcode")) this.db.exec("ALTER TABLE products ADD COLUMN barcode TEXT");
      if (!prodCols.includes("isRawIntake")) {
        this.db.exec("ALTER TABLE products ADD COLUMN isRawIntake INTEGER NOT NULL DEFAULT 0");
        // One-time best-effort flagging for existing databases: if a product's
        // name already exactly matches one of the butchery's known raw-intake
        // items (under whichever name the admin happened to use), flag it
        // automatically rather than leaving every existing admin to redo this
        // by hand. Anything that doesn't match exactly is left for the admin
        // to flag themselves via the new checkbox on the product form.
        const rawIntakeNames = ["whole forequarter", "beef forequarter", "liver", "lungs", "oxtail", "whole lamb", "lamb hind"];
        const placeholders = rawIntakeNames.map(() => "?").join(",");
        this.db.prepare(`UPDATE products SET isRawIntake = 1 WHERE lower(name) IN (${placeholders})`).run(...rawIntakeNames);
      }
    }

    // Add locationId to weigh_in_lines if missing (existing databases) — nullable,
    // since historical lines predate per-location tracking and never had one.
    const weighInLinesExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='weigh_in_lines'").get() as { n: number }).n > 0;
    if (weighInLinesExists) {
      const wilCols = (this.db.prepare("PRAGMA table_info(weigh_in_lines)").all() as { name: string }[]).map((c) => c.name);
      if (!wilCols.includes("locationId")) this.db.exec("ALTER TABLE weigh_in_lines ADD COLUMN locationId INTEGER REFERENCES stock_locations(id)");
    }

    // Add wantedPrice to order_items if missing (existing databases) — nullable,
    // since historical lines predate the "wanted price instead of weight" feature.
    const orderItemsExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='order_items'").get() as { n: number }).n > 0;
    if (orderItemsExists) {
      const oiCols = (this.db.prepare("PRAGMA table_info(order_items)").all() as { name: string }[]).map((c) => c.name);
      if (!oiCols.includes("wantedPrice")) this.db.exec("ALTER TABLE order_items ADD COLUMN wantedPrice REAL");
    }

    // Needed before the CREATE TABLE below runs (which would otherwise make
    // product_stock exist unconditionally) — decides whether the one-time
    // "migrate onHandQty into a default location" step at the bottom of this
    // method should run.
    const hadProductStock = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='product_stock'").get() as { n: number }).n > 0;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        pin TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        department TEXT,
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT,
        lastSeenAt TEXT,
        themeMode TEXT
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
        lowStockThreshold REAL,
        onHandQty REAL NOT NULL DEFAULT 0,
        lastCountedAt TEXT,
        lastCountedById INTEGER REFERENCES users(id),
        barcode TEXT,
        isRawIntake INTEGER NOT NULL DEFAULT 0,
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
        wantedPrice REAL,
        department TEXT NOT NULL DEFAULT 'counter'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weigh_in_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'open',
        createdById INTEGER REFERENCES users(id),
        createdAt TEXT NOT NULL,
        finalizedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS weigh_in_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batchId INTEGER NOT NULL REFERENCES weigh_in_batches(id) ON DELETE CASCADE,
        productId INTEGER NOT NULL REFERENCES products(id),
        grade TEXT NOT NULL,
        piecesReceived REAL NOT NULL,
        weightKg REAL NOT NULL,
        supplierId INTEGER REFERENCES suppliers(id),
        locationId INTEGER REFERENCES stock_locations(id),
        createdById INTEGER REFERENCES users(id),
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_stock (
        productId INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        locationId INTEGER NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
        qty REAL NOT NULL DEFAULT 0,
        lastCountedAt TEXT,
        lastCountedById INTEGER REFERENCES users(id),
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (productId, locationId)
      );

      CREATE INDEX IF NOT EXISTS idx_oi_orderId    ON order_items(orderId);
      CREATE INDEX IF NOT EXISTS idx_ord_status    ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_ord_updatedAt ON orders(updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_usr_name      ON users(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_wil_batchId   ON weigh_in_lines(batchId);
      CREATE INDEX IF NOT EXISTS idx_wil_createdAt ON weigh_in_lines(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_wib_status    ON weigh_in_batches(status);
      CREATE INDEX IF NOT EXISTS idx_pstock_location ON product_stock(locationId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_barcode ON products(barcode) WHERE barcode IS NOT NULL;
    `);

    // One-time migration for databases that predate per-location stock
    // tracking: create a default "Main" location and move each product's
    // existing onHandQty total into it, so nothing is lost — the admin can
    // split it across real locations afterward via ordinary stock counts.
    // Skipped entirely on a fresh install (seed() sets up locations itself).
    if (!hadProductStock) {
      const { count } = this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      if (count > 0) {
        const now = new Date().toISOString();
        this.db.prepare("INSERT OR IGNORE INTO stock_locations (name, isActive, createdAt) VALUES ('Main', 1, ?)").run(now);
        const main = this.db.prepare("SELECT id FROM stock_locations WHERE name = 'Main' COLLATE NOCASE").get() as { id: number };
        const productsWithStock = this.db.prepare("SELECT id, onHandQty, lastCountedAt, lastCountedById FROM products WHERE onHandQty > 0").all() as { id: number; onHandQty: number; lastCountedAt: string | null; lastCountedById: number | null }[];
        const insStock = this.db.prepare("INSERT OR IGNORE INTO product_stock (productId, locationId, qty, lastCountedAt, lastCountedById, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
        for (const p of productsWithStock) {
          insStock.run(p.id, main.id, p.onHandQty, p.lastCountedAt, p.lastCountedById, now);
        }
      }
    }

    // Seed default settings
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('autoPrint', 'false')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('printStyle', 'thermal')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchenPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('counterPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('masterPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('historyDays', '30')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('siteName', 'MAXIS')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('logoUrl', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('themeColor', '')").run();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // Populates a brand-new database with a default admin login (Admin/0000
  // — meant to be changed immediately) and a starter product catalog, so
  // the app is usable right after install without manual setup. No-ops on
  // any database that already has at least one user.
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

    // The fixed set of raw whole-carcass/organ items this butchery actually
    // takes delivery of — flagged isRawIntake so they're what shows up in
    // the Weigh-In receiving screen (see WeighInPanel in src/ui/App.tsx).
    // Lamb Hind is included because it's logged alongside Whole Lamb at
    // intake (sold on as-is, not processed), not because it's itself a
    // format the butchery is delivered separately.
    const insIntake = this.db.prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, isRawIntake, isActive, createdAt, updatedAt) VALUES (?, 'Meat Intake', 'kg', NULL, '', 'counter', 1, 1, ?, ?)");
    for (const name of ["Whole Forequarter", "Liver", "Lungs", "Oxtail", "Whole Lamb", "Lamb Hind"]) {
      insIntake.run(name, now, now);
    }

    // A starting location so Weigh-In/Stock Take aren't empty on day one —
    // admin can rename it or add more via Settings.
    this.db.prepare("INSERT INTO stock_locations (name, isActive, createdAt) VALUES ('Main', 1, ?)").run(now);
  }
}
