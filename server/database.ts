// SQLite data access layer. One class wraps the whole schema — every query
// the server needs lives here, grouped by domain (users/products/suppliers/
// weigh-ins/orders/settings) with `migrate()` handling both fresh installs
// (CREATE TABLE IF NOT EXISTS) and upgrading existing databases in place
// (guarded ALTER TABLE, checked via PRAGMA table_info before running).
import BetterSqlite3 from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  Product, ProductInput, QuickCreateProductInput,
  Order, OrderItem, OrderItemInput, CreateOrderInput, OrderStatus,
  User, UserInput,
  Department, DeptStatus, DeliveryAddress,
  Supplier, WeighInBatch, WeighInBatchSummary, WeighInLine, WeighInLineInput,
  StockLocation, ProductStockRow, ItemSalesStat, ItemStockMovementStat, StatisticsOverview,
  MarginStat, MarginOverview, YieldEstimate, YieldEstimateInput, PendingYieldConversion, PendingYieldItem,
  CrmContact, CrmContactInput, CrmMessage, MessageDirection, MessageType, MessageStatus,
  WhatsappOutboxItem, CrmAutomationRule, ConsentStatus, CrmContactDetail, CrmTag, EmailOutboxItem, EmailSubscriber, OrderMessageTemplate, LabelFormat, LabelFormatInput
} from "../src/shared/types.js";
import { generateInternalBarcode } from "../src/shared/internalBarcode.js";
import { generateConsolidationBarcode } from "../src/shared/orderConsolidationBarcode.js";
import { parseWeighBarcode } from "../src/shared/weighBarcode.js";
import { weightedMarginPct } from "../src/shared/margin.js";

export class KotDatabase {
  private db!: BetterSqlite3.Database;

  // Opens (or creates) the SQLite file under DATA_DIR, then brings the
  // schema up to date and seeds default data on a first run.
  initialize() {
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "nemenchpos.sqlite");
    // One-time, automatic forward-migration for any instance still running
    // under the old filename (maxis.sqlite, from before the product
    // rename) — renamed in place on first boot under the new name so
    // existing data is never silently orphaned or (worse) replaced by a
    // fresh empty database that just happens to share a directory.
    const legacyDbPath = path.join(dataDir, "maxis.sqlite");
    if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
      fs.renameSync(legacyDbPath, dbPath);
      for (const ext of ["-wal", "-shm"]) {
        if (fs.existsSync(legacyDbPath + ext)) fs.renameSync(legacyDbPath + ext, dbPath + ext);
      }
      console.log(`[NemenchPos] Migrated database file: ${legacyDbPath} -> ${dbPath}`);
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seed();
    // Startup reconciliation pass (index.ts calls initialize() once, at
    // boot) — see reconcileMissingCodes' own comment for why this is
    // needed even though upsertProduct already auto-generates a
    // barcode/itemCode for a normal product save.
    this.reconcileMissingCodes();
  }

  // Fixed-unit products should always end up with a real, scannable
  // barcode (see upsertProduct's schema comment) — upsertProduct already
  // auto-generates one on every normal save, but that's not the only way
  // a row can reach the products table: CSV import (importProducts,
  // below) writes directly with raw SQL and never touches barcode at
  // all, and a database created before this feature existed could have
  // old rows that predate it too. This is the catch-all safety net for
  // both — run automatically at startup (see the constructor) and again
  // at the end of every CSV import, with NO human confirmation required,
  // since "every qty product is scannable" is a structural invariant of
  // this app, not an optional cleanup a human should have to approve.
  // Weighed products are deliberately excluded — they never have a
  // static barcode by design (see weighBarcode.ts). Never overwrites an
  // existing barcode, only fills a genuinely null/empty one, and returns
  // the ids it touched so callers can log them for an audit trail.
  reconcileMissingBarcodes(): number[] {
    const missing = this.db
      .prepare("SELECT id FROM products WHERE isActive = 1 AND unitDefault = 'qty' AND (barcode IS NULL OR barcode = '')")
      .all() as { id: number }[];
    const fixedIds: number[] = [];
    for (const { id } of missing) {
      this.db.prepare("UPDATE products SET barcode = ? WHERE id = ?").run(generateInternalBarcode(id), id);
      fixedIds.push(id);
    }
    if (fixedIds.length > 0) {
      console.log(`[barcode-reconcile] Generated barcodes for ${fixedIds.length} product(s) that had none: ${fixedIds.join(", ")}`);
    }
    return fixedIds;
  }

  // The weighed-product counterpart to reconcileMissingBarcodes above —
  // same gap, same fix. upsertProduct already auto-assigns an itemCode
  // (scale PLU) for a weighed product missing one on every normal save
  // (see generateItemCode), but CSV import and any pre-existing/legacy
  // row bypass that entirely, exactly like the barcode case. Every
  // active product must end up with SOME code — a static barcode if
  // fixed-unit, an item code if weighed — never neither. Never
  // overwrites an existing itemCode, only fills a genuinely null/empty
  // one.
  reconcileMissingItemCodes(): number[] {
    const missing = this.db
      .prepare("SELECT id FROM products WHERE isActive = 1 AND unitDefault != 'qty' AND (itemCode IS NULL OR itemCode = '')")
      .all() as { id: number }[];
    const fixedIds: number[] = [];
    for (const { id } of missing) {
      this.db.prepare("UPDATE products SET itemCode = ? WHERE id = ?").run(this.generateItemCode(id), id);
      fixedIds.push(id);
    }
    if (fixedIds.length > 0) {
      console.log(`[itemcode-reconcile] Generated item codes for ${fixedIds.length} product(s) that had none: ${fixedIds.join(", ")}`);
    }
    return fixedIds;
  }

  // Single entry point for "every active product has some code" — called
  // at startup and after every CSV import (see initialize()/
  // importProducts() below). Barcodes first: reconcileMissingItemCodes
  // calls generateItemCode, which scans every OTHER product's itemCode to
  // avoid a collision, and running barcode reconciliation first doesn't
  // affect that scan either way, but keeping a fixed order here makes the
  // audit log output deterministic run to run.
  reconcileMissingCodes(): void {
    this.reconcileMissingBarcodes();
    this.reconcileMissingItemCodes();
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

  // Correlated subquery for the most recent product_cost_history row per
  // product — appended to every query that returns a Product, since
  // currentCost is derived, not a column. `alias` lets callers that don't
  // use "p" as their products-table alias (there are none currently, but
  // keeps this from silently breaking if that changes) pass their own.
  private static currentCostSql(alias = "p"): string {
    return `(SELECT costPerUnit FROM product_cost_history pch WHERE pch.productId = ${alias}.id ORDER BY pch.effectiveFrom DESC, pch.id DESC LIMIT 1) as currentCost`;
  }

  getCurrentCost(productId: number): number | null {
    const row = this.db
      .prepare("SELECT costPerUnit FROM product_cost_history WHERE productId = ? ORDER BY effectiveFrom DESC, id DESC LIMIT 1")
      .get(productId) as { costPerUnit: number } | undefined;
    return row?.costPerUnit ?? null;
  }

  // Appends a new cost-history row rather than updating one in place — see
  // the product_cost_history table comment for why (a sale must be able to
  // snapshot whatever cost was current *then*, even after it changes again).
  setProductCost(productId: number, costPerUnit: number, createdById: number | null): void {
    if (costPerUnit < 0) throw new Error("Cost price can't be negative");
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO product_cost_history (productId, costPerUnit, effectiveFrom, createdById, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(productId, costPerUnit, now, createdById, now);
  }

  // Active products that have never had a cost recorded — the admin
  // "Products needing cost price" list. Deliberately not "cost is 0",
  // since 0 is a real (if unusual) cost and shouldn't be conflated with
  // "nobody has entered one yet."
  listProductsMissingCost(): Product[] {
    return this.db
      .prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.itemCode, p.isRawIntake, p.createdAt, p.updatedAt, ${KotDatabase.currentCostSql()}
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id
        WHERE p.isActive = 1
        GROUP BY p.id
        HAVING currentCost IS NULL
        ORDER BY p.category, p.name`)
      .all() as Product[];
  }

  // ── Cut yield estimates ────────────────────────────────────────────────────

  listYieldEstimates(rawProductId: number): YieldEstimate[] {
    return this.db
      .prepare(`
        SELECT e.id, e.rawProductId, e.subProductId, p.name as subProductName, e.yieldPct
        FROM product_yield_estimates e
        JOIN products p ON p.id = e.subProductId
        WHERE e.rawProductId = ?
        ORDER BY e.yieldPct DESC`)
      .all(rawProductId) as YieldEstimate[];
  }

  // Replace-all semantics — simpler and safer than diffing add/remove/edit
  // client-side, and this list is short (a handful of cuts per raw item).
  // Existing pending_yield_conversions are untouched: their yieldPct/
  // estimatedKg were already snapshotted at creation time (see
  // addWeighInLine), so changing the estimate here never retroactively
  // rewrites a conversion still awaiting review.
  setYieldEstimates(rawProductId: number, estimates: YieldEstimateInput[]): YieldEstimate[] {
    const now = new Date().toISOString();
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM product_yield_estimates WHERE rawProductId = ?").run(rawProductId);
      const insert = this.db.prepare(
        "INSERT INTO product_yield_estimates (rawProductId, subProductId, yieldPct, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
      );
      for (const e of estimates) {
        if (e.yieldPct <= 0) continue; // a 0%/blank row is "no estimate," not worth storing
        insert.run(rawProductId, e.subProductId, e.yieldPct, now, now);
      }
    });
    replace();
    return this.listYieldEstimates(rawProductId);
  }

  private pendingYieldConversionRow(id: number): PendingYieldConversion {
    const conv = this.db
      .prepare(`
        SELECT c.*, p.name as rawProductName, loc.name as locationName, u.name as resolvedByName
        FROM pending_yield_conversions c
        JOIN products p ON p.id = c.rawProductId
        LEFT JOIN stock_locations loc ON loc.id = c.locationId
        LEFT JOIN users u ON u.id = c.resolvedById
        WHERE c.id = ?`)
      .get(id) as PendingYieldConversion | undefined;
    if (!conv) throw new Error(`Pending yield conversion ${id} not found`);
    const items = this.db
      .prepare(`
        SELECT i.id, i.subProductId, p.name as subProductName, i.estimatedKg, i.yieldPct
        FROM pending_yield_items i
        JOIN products p ON p.id = i.subProductId
        WHERE i.conversionId = ?
        ORDER BY i.estimatedKg DESC`)
      .all(id) as PendingYieldItem[];
    return { ...conv, items };
  }

  listPendingYieldConversions(status: "pending" | "applied" | "dismissed" = "pending"): PendingYieldConversion[] {
    const rows = this.db
      .prepare("SELECT id FROM pending_yield_conversions WHERE status = ? ORDER BY createdAt DESC")
      .all(status) as { id: number }[];
    return rows.map((r) => this.pendingYieldConversionRow(r.id));
  }

  // Actually adjusts stock — the one moment any of this touches on-hand
  // quantities. `items` carries whatever kg the reviewer settled on
  // (usually the estimate, but editable — see the pending_yield_items
  // table comment), not necessarily what was originally estimated.
  applyYieldConversion(id: number, items: { subProductId: number; kg: number }[], resolvedById: number): PendingYieldConversion {
    const conv = this.pendingYieldConversionRow(id);
    if (conv.status !== "pending") throw new Error(`Conversion ${id} is already ${conv.status}`);
    const now = new Date().toISOString();
    const apply = this.db.transaction(() => {
      for (const item of items) {
        if (item.kg > 0) this.adjustProductStock(item.subProductId, conv.locationId, item.kg);
      }
      this.db.prepare("UPDATE pending_yield_conversions SET status = 'applied', resolvedAt = ?, resolvedById = ? WHERE id = ?").run(now, resolvedById, id);
    });
    apply();
    return this.pendingYieldConversionRow(id);
  }

  // No stock change at all — for when the actual cutting never happened
  // as estimated (or didn't happen yet) and the estimate shouldn't be
  // applied as-is.
  dismissYieldConversion(id: number, resolvedById: number): PendingYieldConversion {
    const conv = this.pendingYieldConversionRow(id);
    if (conv.status !== "pending") throw new Error(`Conversion ${id} is already ${conv.status}`);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE pending_yield_conversions SET status = 'dismissed', resolvedAt = ?, resolvedById = ? WHERE id = ?").run(now, resolvedById, id);
    return this.pendingYieldConversionRow(id);
  }

  listProducts(): Product[] {
    return this.db
      .prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.itemCode, p.isRawIntake, p.createdAt, p.updatedAt, ${KotDatabase.currentCostSql()}
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id
        WHERE p.isActive = 1
        GROUP BY p.id
        ORDER BY p.category, p.name`)
      .all() as Product[];
  }

  // POS "quick picks" row — an admin's manually-pinned product list
  // (posQuickPickIds setting, comma-separated ids, in the order they
  // should appear) if one's been set, otherwise auto-derived from actual
  // recent sales: top N products by number of order-item lines in the
  // last 30 days, so it tracks what's actually selling right now rather
  // than a stale all-time snapshot. Configurable, never hardcoded.
  getQuickPickProducts(limit = 6): Product[] {
    const pinnedRaw = (this.db.prepare("SELECT value FROM settings WHERE key = 'posQuickPickIds'").get() as { value: string } | undefined)?.value ?? "";
    const pinnedIds = pinnedRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

    if (pinnedIds.length > 0) {
      const placeholders = pinnedIds.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.itemCode, p.isRawIntake, p.createdAt, p.updatedAt, ${KotDatabase.currentCostSql()}
        FROM products p
        LEFT JOIN product_stock ps ON ps.productId = p.id
        WHERE p.isActive = 1 AND p.id IN (${placeholders})
        GROUP BY p.id`
      ).all(...pinnedIds) as Product[];
      // Preserve the admin's chosen order — SQL's IN() gives no ordering
      // guarantee of its own.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return pinnedIds.map((id) => byId.get(id)).filter((p): p is Product => !!p).slice(0, limit);
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
             p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
             p.barcode, p.itemCode, p.isRawIntake, p.createdAt, p.updatedAt, ${KotDatabase.currentCostSql()}
      FROM products p
      LEFT JOIN product_stock ps ON ps.productId = p.id
      WHERE p.isActive = 1
      GROUP BY p.id
      HAVING (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.orderId WHERE oi.productId = p.id AND o.createdAt >= ?) > 0
      ORDER BY (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.orderId WHERE oi.productId = p.id AND o.createdAt >= ?) DESC
      LIMIT ?`
    ).all(since, since, limit) as Product[];
  }

  getProductByBarcode(barcode: string): Product | null {
    return this.db
      .prepare(`SELECT p.*, ${KotDatabase.currentCostSql()} FROM products p WHERE p.barcode = ? AND p.isActive = 1`)
      .get(barcode) as Product | null;
  }

  // A weighed product's identity for scanning purposes — see itemCode's
  // schema comment (migrate()). Distinct from getProductByBarcode: a
  // weighed product's `barcode` column is null (it has no single static
  // barcode), so scanning one always resolves through here instead,
  // after parseWeighBarcode strips the price digits off the raw scan.
  getProductByItemCode(itemCode: string): Product | null {
    return this.db
      .prepare(`SELECT p.*, ${KotDatabase.currentCostSql()} FROM products p WHERE p.itemCode = ? AND p.isActive = 1`)
      .get(itemCode) as Product | null;
  }

  // Picks a free 5-digit item code (scale PLU) for a weighed product that
  // wasn't given one explicitly — scans every itemCode already in use and
  // returns the lowest unused number, so two products can never collide.
  // excludeId lets an update check against everyone ELSE's code without
  // tripping over the row's own current value. A butcher who needs the
  // system's assignment to match a *specific* physical PLU already
  // programmed into the scale can still just type that number into the
  // item code field themselves — this only fills the gap when they don't.
  private generateItemCode(excludeId?: number): string {
    const used = new Set(
      (this.db.prepare("SELECT id, itemCode FROM products WHERE itemCode IS NOT NULL").all() as { id: number; itemCode: string }[])
        .filter((r) => r.id !== excludeId)
        .map((r) => r.itemCode)
    );
    for (let n = 1; n <= 99999; n++) {
      const candidate = String(n).padStart(5, "0");
      if (!used.has(candidate)) return candidate;
    }
    throw new Error("No available item codes left (00001-99999 all in use)");
  }

  // If no barcode is entered for a FIXED-UNIT product, one is auto-
  // generated from the product's own id (see generateInternalBarcode)
  // rather than left null — every fixed-unit product ends up scannable,
  // whether or not it has a real manufacturer barcode. A WEIGHED product
  // gets the same treatment for its itemCode (see generateItemCode above)
  // when none is entered — checked against every other product's code so
  // two items can never end up sharing a PLU. Entering a specific item
  // code still always wins over auto-assignment (e.g. to match a code
  // already programmed into the physical scale). For a brand-new product
  // the id doesn't exist until after the INSERT, so both auto-assignments
  // happen in a follow-up UPDATE rather than up front.
  //
  // costPerUnit is handled separately from the rest of the fields: if
  // provided, it appends a new product_cost_history row (see
  // setProductCost) via the caller (routes/products.ts), not here — this
  // method only touches the products table itself.
  upsertProduct(input: ProductInput): Product {
    const now = new Date().toISOString();
    const isWeighed = input.unitDefault !== "qty";
    const providedBarcode = input.barcode?.trim() || null;
    const providedItemCode = input.itemCode?.trim() || null;
    if (providedItemCode && !/^\d{5}$/.test(providedItemCode)) {
      throw new Error(`Item code "${providedItemCode}" must be exactly 5 digits`);
    }
    const isRawIntake = input.isRawIntake ? 1 : 0;
    if (input.id) {
      const barcode = isWeighed ? providedBarcode : (providedBarcode ?? generateInternalBarcode(input.id));
      const itemCode = isWeighed ? (providedItemCode ?? this.generateItemCode(input.id)) : providedItemCode;
      this.db
        .prepare("UPDATE products SET name=?, category=?, unitDefault=?, pricePerUnit=?, prepNotes=?, department=?, lowStockThreshold=?, barcode=?, itemCode=?, isRawIntake=?, updatedAt=? WHERE id=?")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, input.lowStockThreshold ?? null, barcode, itemCode, isRawIntake, now, input.id);
      return this.db.prepare(`SELECT p.*, ${KotDatabase.currentCostSql()} FROM products p WHERE p.id = ?`).get(input.id) as Product;
    } else {
      const result = this.db
        .prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, lowStockThreshold, barcode, itemCode, isRawIntake, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), input.department, input.lowStockThreshold ?? null, providedBarcode, providedItemCode, isRawIntake, now, now);
      const newId = Number(result.lastInsertRowid);
      if (!isWeighed && !providedBarcode) {
        this.db.prepare("UPDATE products SET barcode = ? WHERE id = ?").run(generateInternalBarcode(newId), newId);
      }
      if (isWeighed && !providedItemCode) {
        this.db.prepare("UPDATE products SET itemCode = ? WHERE id = ?").run(this.generateItemCode(newId), newId);
      }
      return this.db.prepare(`SELECT p.*, ${KotDatabase.currentCostSql()} FROM products p WHERE p.id = ?`).get(newId) as Product;
    }
  }

  // Minimal product creation from an unrecognized barcode scan at the
  // register — everything but name/code/price/department defaults
  // sensibly (same defaults as CSV import), so a cashier can add a new
  // item in one step without needing full admin product-management
  // access. Exactly one of barcode/itemCode is expected — the caller
  // (BarcodeAddModal) already knows which, from whether parseWeighBarcode
  // decoded the original scan — and which one determines unitDefault:
  // a weigh-scale PLU means this is necessarily a weighed product (it can
  // only have come from a scale label), a plain barcode means fixed-unit.
  quickCreateProductByBarcode(input: QuickCreateProductInput): Product {
    const barcode = input.barcode?.trim() || null;
    const itemCode = input.itemCode?.trim() || null;
    if (!barcode && !itemCode) throw new Error("A barcode or item code is required");
    const name = input.name.trim();
    if (!name) throw new Error("Name is required");
    if (barcode && this.getProductByBarcode(barcode)) throw new Error("A product with this barcode already exists");
    if (itemCode && this.getProductByItemCode(itemCode)) throw new Error("A product with this item code already exists");
    return this.upsertProduct({
      name,
      category: "General",
      unitDefault: itemCode ? "kg" : "qty",
      pricePerUnit: input.pricePerUnit,
      prepNotes: "",
      department: input.department,
      lowStockThreshold: null,
      barcode: barcode ?? undefined,
      itemCode: itemCode ?? undefined
    });
  }

  listLowStock(): Product[] {
    return this.db
      .prepare(`
        SELECT p.id, p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department, p.isActive,
               p.lowStockThreshold, COALESCE(SUM(ps.qty), 0) as onHandQty, p.lastCountedAt, p.lastCountedById,
               p.barcode, p.itemCode, p.isRawIntake, p.createdAt, p.updatedAt, ${KotDatabase.currentCostSql()}
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
      const lineId = Number(result.lastInsertRowid);
      this.adjustProductStock(input.productId, input.locationId, input.piecesReceived);

      // If this raw item has configured cut-yield estimates, queue a
      // pending conversion — this only *proposes* stock for the cut
      // sub-products (Mince, Steak, ...); nothing is added until someone
      // explicitly applies it later (see applyYieldConversion). yieldPct
      // is snapshotted per item now, not read live when later reviewed.
      const estimates = this.listYieldEstimates(input.productId);
      if (estimates.length > 0) {
        const convResult = this.db
          .prepare("INSERT INTO pending_yield_conversions (weighInLineId, rawProductId, weightKgReceived, locationId, status, createdAt) VALUES (?, ?, ?, ?, 'pending', ?)")
          .run(lineId, input.productId, input.weightKg, input.locationId, now);
        const conversionId = Number(convResult.lastInsertRowid);
        const insertItem = this.db.prepare(
          "INSERT INTO pending_yield_items (conversionId, subProductId, estimatedKg, yieldPct) VALUES (?, ?, ?, ?)"
        );
        for (const e of estimates) {
          insertItem.run(conversionId, e.subProductId, Number((input.weightKg * (e.yieldPct / 100)).toFixed(3)), e.yieldPct);
        }
      }
      return lineId;
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
  importProducts(rows: { name: string; category: string; unitDefault: string; pricePerUnit: string; prepNotes: string; department: string; costPerUnit?: string }[], createdById: number | null): { imported: number; errors: string[] } {
    const now = new Date().toISOString();
    let imported = 0;
    const errors: string[] = [];
    const upsert = this.db.transaction(() => {
      for (const [i, row] of rows.entries()) {
        const name = row.name?.trim();
        if (!name) { errors.push(`Row ${i + 2}: name is required`); continue; }
        const category = row.category?.trim() || "General";
        // Whitelist against the REAL UnitDefault values ("kg"|"qty"|
        // "kg_qty" — see shared/types.ts). This used to check against a
        // pre-rename set ("kg"/"each"/"g"/"pack") that no longer matches
        // anything real, silently coercing every imported row to "kg"
        // (weighed) regardless of what was actually in the CSV — meaning
        // a fixed-unit ("qty") product could never be created via import
        // at all, and so could never pick up an auto-generated barcode
        // either (see reconcileMissingBarcodes/upsertProduct, which both
        // only ever act on unitDefault='qty' products).
        const unitDefault = ["kg", "qty", "kg_qty"].includes(row.unitDefault) ? row.unitDefault : "kg";
        const price = row.pricePerUnit ? parseFloat(row.pricePerUnit) : null;
        const dept = row.department === "kitchen" ? "kitchen" : "counter";
        const prepNotes = row.prepNotes?.trim() || "";
        const cost = row.costPerUnit?.trim() ? parseFloat(row.costPerUnit) : null;
        const existing = this.db.prepare("SELECT id FROM products WHERE lower(name) = lower(?) AND isActive = 1").get(name) as { id: number } | null;
        let productId: number;
        if (existing) {
          this.db.prepare("UPDATE products SET category=?, unitDefault=?, pricePerUnit=?, prepNotes=?, department=?, updatedAt=? WHERE id=?")
            .run(category, unitDefault, price, prepNotes, dept, now, existing.id);
          productId = existing.id;
        } else {
          const result = this.db.prepare("INSERT INTO products (name, category, unitDefault, pricePerUnit, prepNotes, department, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
            .run(name, category, unitDefault, price, prepNotes, dept, now, now);
          productId = Number(result.lastInsertRowid);
        }
        // Same dedup-by-value guard as the manual edit form's
        // maybeUpdateCost (routes/products.ts) — only inserts a new
        // product_cost_history row when the value actually changed, so
        // re-importing the same CSV repeatedly doesn't grow a duplicate
        // row per run.
        if (cost != null && !Number.isNaN(cost) && this.getCurrentCost(productId) !== cost) {
          this.setProductCost(productId, cost, createdById);
        }
        imported++;
      }
    });
    upsert();
    // CSV import writes rows directly rather than through upsertProduct,
    // so it never gets that method's own barcode/itemCode auto-
    // generation — this fixes any newly-imported/updated product left
    // without a code.
    this.reconcileMissingCodes();
    return { imported, errors };
  }

  exportProducts(): string {
    const products = this.db
      .prepare(`
        SELECT p.name, p.category, p.unitDefault, p.pricePerUnit, p.prepNotes, p.department,
               (SELECT costPerUnit FROM product_cost_history WHERE productId = p.id ORDER BY effectiveFrom DESC, id DESC LIMIT 1) as costPerUnit
        FROM products p WHERE p.isActive = 1 ORDER BY p.category, p.name`)
      .all() as { name: string; category: string; unitDefault: string; pricePerUnit: number | null; prepNotes: string; department: string; costPerUnit: number | null }[];
    const header = "name,category,unitDefault,pricePerUnit,prepNotes,department,costPerUnit";
    const rows = products.map((p) => [p.name, p.category, p.unitDefault, p.pricePerUnit ?? "", p.prepNotes, p.department, p.costPerUnit ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","));
    return [header, ...rows].join("\n");
  }

  // Every real data table except `settings` (flattened to a plain key/value
  // object below, since that's how the rest of the app already treats it)
  // and `local_profile_cache` (deliberately excluded — it's just a cached
  // copy of the last control-plane sync, not real business data; it
  // self-heals within 15 minutes of the server starting either way, so
  // restoring a stale copy would only ever be actively wrong).
  //
  // IMPORTANT: this list is the single source of truth for what a backup
  // covers. When adding a new table to the schema (see migrate()'s "(3)
  // CREATE TABLE IF NOT EXISTS" block), add its name here too — everything
  // else (export, delete-on-restore, insert-on-restore, column list) is
  // derived automatically from the table's own real schema, so there's no
  // separate column list to keep in sync and forget (a past bug: orders'
  // discountAmount/paymentMethod/cashTendered/crmContactId columns were
  // captured on export but silently dropped on import, because the old
  // restore INSERT hand-typed an older, shorter column list).
  private static readonly BACKUP_TABLES = [
    "users", "suppliers", "stock_locations", "crm_contacts", "crm_tags",
    "products", "crm_contact_tags", "crm_messages", "whatsapp_outbox", "crm_automation_rules",
    "orders", "order_items", "weigh_in_batches", "weigh_in_lines",
    "product_cost_history", "product_yield_estimates", "pending_yield_conversions", "pending_yield_items",
    "product_stock", "email_outbox", "email_subscribers", "order_message_templates", "label_formats"
  ];

  private tableColumns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  }

  // Snapshots every table in BACKUP_TABLES into one plain object for the
  // admin's downloadable backup file, via a genuine `SELECT *` — whatever
  // columns actually exist on the table, no hand-typed list to fall behind.
  exportBackup(): Record<string, unknown> {
    const data: Record<string, unknown> = { version: 1, exportedAt: new Date().toISOString() };
    for (const table of KotDatabase.BACKUP_TABLES) {
      data[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
    }
    const settings = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    data.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    return data;
  }

  // Wipes and replaces every table in BACKUP_TABLES from a backup file,
  // preserving original row IDs (so foreign keys between orders/order_items
  // etc. stay valid). Runs with foreign_keys temporarily OFF because SQLite
  // requires that outside of a transaction, and a mid-restore state would
  // otherwise violate FK constraints along the way.
  //
  // Each table's INSERT column list is built from the intersection of (a)
  // the keys actually present on the first row of that table's backed-up
  // data and (b) that table's real current columns (via PRAGMA table_info)
  // — so a backup taken on an older schema version still restores cleanly
  // (missing newer columns just fall back to their table DEFAULT), and a
  // backup with a stray/renamed key can't be used to write into a column
  // that doesn't really exist.
  importBackup(data: Record<string, unknown>): Record<string, number> {
    if (!data.version || !Array.isArray(data.products)) throw new Error("Invalid backup file");
    const settings = (data.settings as Record<string, string>) ?? {};
    const counts: Record<string, number> = {};

    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        for (const table of [...KotDatabase.BACKUP_TABLES].reverse()) {
          this.db.exec(`DELETE FROM ${table}`);
        }
        for (const table of KotDatabase.BACKUP_TABLES) {
          const rows = (data[table] as Record<string, unknown>[]) ?? [];
          counts[table] = rows.length;
          if (rows.length === 0) continue;
          const validColumns = new Set(this.tableColumns(table));
          const columns = Object.keys(rows[0]).filter((c) => validColumns.has(c));
          const insert = this.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
          for (const row of rows) insert.run(...columns.map((c) => row[c] ?? null));
        }
        for (const [key, value] of Object.entries(settings)) {
          this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
        }
      })();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    return counts;
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

    const discountAmount = Math.max(0, input.discountAmount ?? 0);
    const paymentMethod = input.paymentMethod === "card" ? "card" : "cash";
    const saleTotal = input.items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0) - discountAmount;

    // SARS requires a full tax invoice (buyer name + address) for any
    // single sale over R5,000 — enforced here too, not just the POS
    // screen's button-disable, since the client is never the actual
    // boundary for a legal requirement like this one.
    if (doneNow) {
      if (saleTotal > 5000 && (!input.customerName.trim() || !input.deliveryAddress?.street?.trim())) {
        throw new Error("Sales over R5,000 require the buyer's name and address (SARS full tax invoice rule)");
      }
      if (paymentMethod === "cash" && (input.cashTendered ?? 0) < saleTotal) {
        throw new Error("Cash tendered must cover the sale total");
      }
    }
    const cashTendered = paymentMethod === "cash" ? (input.cashTendered ?? null) : null;

    // Every catalog item in a completed (POS) sale must have a recorded
    // cost price — enforced here, not just the POS grid disabling the tap,
    // for the same "client isn't the real boundary" reason as the R5,000
    // check above. Computed once per item and reused below so a sale can't
    // half-complete with some lines costed and others not. Free-text lines
    // (no productId) have nothing to check against and are always allowed.
    const costPerItem = new Map<number, number | null>();
    for (const item of input.items) {
      if (!item.productId || costPerItem.has(item.productId)) continue;
      costPerItem.set(item.productId, this.getCurrentCost(item.productId));
    }
    if (doneNow) {
      for (const item of input.items) {
        if (item.productId && costPerItem.get(item.productId) == null) {
          throw new Error(`"${item.name}" has no cost price set — add one in Stock before it can be sold`);
        }
      }
    }

    // Optional POS "Customer number" capture (see CreateOrderInput.
    // customerNumber) — resolved to a crm_contacts row before the INSERT so
    // crmContactId can be set in one write. Left blank, this is a no-op:
    // no DB writes beyond the order itself, no added latency, order stays
    // unlinked. A phone number always resolves (creating a new contact if
    // there's no match), so this never fails a sale over a typo'd number.
    const crmContactId = input.customerNumber?.trim() ? this.resolveOrCreateContactByPhone(input.customerNumber.trim()).id : null;

    // Set only for a completeImmediately (POS) sale — the one point
    // "paid" is an actually-known fact today (see the paidAt column
    // comment in migrate()). A regular KOT ticket stays null here forever
    // until a real "mark as paid" staff action exists.
    const paidAt = doneNow ? now : null;

    const result = this.db
      .prepare("INSERT INTO orders (ticketNumber, customerName, customerPhone, orderType, deliveryAddress, requestedTime, assignedTo, status, kitchenStatus, counterStatus, requestedById, createdAt, updatedAt, discountAmount, paymentMethod, cashTendered, crmContactId, customerEmail, paidAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ticketNumber, input.customerName.trim(), input.customerPhone.trim(), input.orderType, input.orderType === "delivery" || input.deliveryAddress?.street ? JSON.stringify(input.deliveryAddress) : "{}", input.requestedTime.trim(), input.assignedTo?.trim() || null, overallStatus, kitchenStatus, counterStatus, requestedById, now, now, discountAmount, paymentMethod, cashTendered, crmContactId, input.customerEmail?.trim() || null, paidAt);

    const orderId = Number(result.lastInsertRowid);
    const insertItem = this.db.prepare(
      "INSERT INTO order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department, costAtSale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of input.items) {
      // Total cost for the line (matching lineTotal being a total, not a
      // per-unit figure) — the cost snapshotted now, at sale time, not
      // whatever product_cost_history says later when a report reads it.
      const unitCost = item.productId ? costPerItem.get(item.productId) : null;
      const costAtSale = unitCost != null ? unitCost * (item.kg || item.quantity || 1) : null;
      insertItem.run(orderId, item.productId ?? null, item.name.trim(), item.kg ?? null, item.quantity ?? null, item.notes.trim(), item.unitPrice ?? null, item.lineTotal ?? null, item.wantedPrice ?? null, item.department, costAtSale);
    }

    // A completeImmediately order is a finished POS sale (see the
    // completeImmediately doc on CreateOrderInput) — stock actually left
    // the shop, so deduct it now. Regular KOT tickets don't touch stock
    // here; they're still New/being prepared, not a completed sale.
    if (doneNow) {
      const salesLocationId = this.resolveSalesLocationId();
      if (salesLocationId != null) {
        for (const item of input.items) {
          if (!item.productId) continue; // free-text lines aren't in the catalog — nothing to deduct
          const amount = item.kg || item.quantity;
          if (amount) this.adjustProductStock(item.productId, salesLocationId, -amount);
        }
      }
    }

    return this.getOrder(orderId);
  }

  // Which stock location a completed sale's items come out of. Explicit
  // admin choice (settings.salesStockLocationId) wins; with exactly one
  // location configured there's only one sensible answer so no setup is
  // required; with zero or several and nothing chosen, skip the deduction
  // entirely rather than guess — an unconfigured shop would rather see
  // stock stay accurate-but-stale than silently wrong.
  private resolveSalesLocationId(): number | null {
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'salesStockLocationId'").get() as { value: string } | null;
    const configured = setting?.value ? Number(setting.value) : null;
    if (configured && this.db.prepare("SELECT 1 FROM stock_locations WHERE id = ? AND isActive = 1").get(configured)) {
      return configured;
    }
    const locations = this.listStockLocations();
    return locations.length === 1 ? locations[0].id : null;
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
             o.requestedById, o.createdAt, o.updatedAt, o.discountAmount, o.paymentMethod, o.cashTendered, o.crmContactId, o.customerEmail, o.paidAt, o.consolidatedAt, o.consolidationBarcode, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.wantedPrice as oi_wantedPrice, oi.department as oi_dept, oi.costAtSale as oi_costAtSale, oi.scannedAt as oi_scannedAt
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
             o.requestedById, o.createdAt, o.updatedAt, o.discountAmount, o.paymentMethod, o.cashTendered, o.crmContactId, o.customerEmail, o.paidAt, o.consolidatedAt, o.consolidationBarcode, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.wantedPrice as oi_wantedPrice, oi.department as oi_dept, oi.costAtSale as oi_costAtSale, oi.scannedAt as oi_scannedAt
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
  // Gross per-item revenue (i.e. before any order-level discount — see
  // Order.discountAmount) since a whole-order discount can't be allocated
  // back to individual lines in any non-arbitrary way. The headline figure
  // in statisticsOverview is net of discounts; this per-item breakdown is
  // gross sales by item, a legitimate metric in its own right.
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
    // Discounts are stored once per order (see Order.discountAmount), not
    // per item, so they're summed from a distinct orders-only query and
    // subtracted from the item-joined gross total — summing them off the
    // order_items join directly would multiply a single order's discount
    // by however many line items it has.
    const totals = (f: string, t: string) => {
      const gross = this.db
        .prepare(`
          SELECT COALESCE(SUM(oi.lineTotal), 0) as grossRevenue,
                 COALESCE(SUM(oi.kg), 0) as totalKg,
                 COALESCE(SUM(oi.quantity), 0) as totalQty,
                 COUNT(DISTINCT oi.orderId) as totalOrders
          FROM order_items oi
          JOIN orders o ON o.id = oi.orderId
          WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?`)
        .get(f, t) as { grossRevenue: number; totalKg: number; totalQty: number; totalOrders: number };
      const { totalDiscount } = this.db
        .prepare(`SELECT COALESCE(SUM(discountAmount), 0) as totalDiscount FROM orders WHERE substr(createdAt, 1, 10) >= ? AND substr(createdAt, 1, 10) <= ?`)
        .get(f, t) as { totalDiscount: number };
      return { totalRevenue: gross.grossRevenue - totalDiscount, totalKg: gross.totalKg, totalQty: gross.totalQty, totalOrders: gross.totalOrders };
    };

    const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
    const shift = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
    const prevTo = shift(from, -1);
    const prevFrom = shift(prevTo, -(days - 1));

    const current = totals(from, to);
    const previous = totals(prevFrom, prevTo);

    // Per-day discount, keyed the same way, subtracted from that day's
    // gross the same way as the headline totals above.
    const discountByDay = new Map(
      (this.db
        .prepare(`SELECT substr(createdAt, 1, 10) as date, SUM(discountAmount) as discount FROM orders WHERE substr(createdAt, 1, 10) >= ? AND substr(createdAt, 1, 10) <= ? GROUP BY date`)
        .all(from, to) as { date: string; discount: number }[])
        .map((r) => [r.date, r.discount])
    );
    const revenueByDay = (this.db
      .prepare(`
        SELECT substr(o.createdAt, 1, 10) as date,
               COALESCE(SUM(oi.lineTotal), 0) as revenue,
               COUNT(DISTINCT o.id) as orders
        FROM orders o
        LEFT JOIN order_items oi ON oi.orderId = o.id
        WHERE substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY date ORDER BY date ASC`)
      .all(from, to) as { date: string; revenue: number; orders: number }[])
      .map((r) => ({ ...r, revenue: r.revenue - (discountByDay.get(r.date) ?? 0) }));

    // Gross, like salesByItem — a whole-order discount can't be split
    // between departments/order-types any less arbitrarily than between
    // items, so these breakdowns intentionally don't net it out. Only the
    // headline totalRevenue/revenueByDay above do.
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

  // Only order_items with a snapshotted costAtSale are included — a
  // free-text line (no productId) or a sale from before this feature
  // existed has no known cost, and reporting it at cost=0 would overstate
  // margin rather than honestly excluding it. These same lines still count
  // in the ordinary (non-margin) Statistics revenue views.
  private marginsByGroup(from: string, to: string, groupBy: "product" | "category" | "day"): MarginStat[] {
    const groupExpr = groupBy === "day" ? "substr(o.createdAt, 1, 10)" : groupBy === "category" ? "p.category" : "oi.productId";
    const labelExpr = groupBy === "day" ? "substr(o.createdAt, 1, 10)" : groupBy === "category" ? "p.category" : "oi.name";
    const productJoin = groupBy === "category" ? "JOIN products p ON p.id = oi.productId" : "";
    const rows = this.db
      .prepare(`
        SELECT CAST(${groupExpr} as TEXT) as id, ${labelExpr} as label,
               COALESCE(SUM(oi.lineTotal), 0) as revenue,
               COALESCE(SUM(oi.costAtSale), 0) as cost,
               COALESCE(SUM(COALESCE(oi.quantity, 0) + COALESCE(oi.kg, 0)), 0) as qtySold
        FROM order_items oi
        JOIN orders o ON o.id = oi.orderId
        ${productJoin}
        WHERE oi.costAtSale IS NOT NULL AND substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?
        GROUP BY ${groupExpr}
        ORDER BY revenue DESC`)
      .all(from, to) as { id: string; label: string; revenue: number; cost: number; qtySold: number }[];
    return rows.map((r) => ({ ...r, profit: r.revenue - r.cost, marginPct: weightedMarginPct(r.revenue, r.cost) }));
  }

  getMarginOverview(from: string, to: string, groupBy: "product" | "category" | "day"): MarginOverview {
    const current = this.marginsByGroup(from, to, groupBy);

    const totals = (f: string, t: string) => this.db
      .prepare(`
        SELECT COALESCE(SUM(oi.lineTotal), 0) as revenue, COALESCE(SUM(oi.costAtSale), 0) as cost
        FROM order_items oi
        JOIN orders o ON o.id = oi.orderId
        WHERE oi.costAtSale IS NOT NULL AND substr(o.createdAt, 1, 10) >= ? AND substr(o.createdAt, 1, 10) <= ?`)
      .get(f, t) as { revenue: number; cost: number };

    const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
    const shift = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
    const prevTo = shift(from, -1);
    const prevFrom = shift(prevTo, -(days - 1));

    const cur = totals(from, to);
    const prev = totals(prevFrom, prevTo);

    // The trend chart is always by day regardless of what grouping the
    // caller asked for in `current` — re-running the query is cheap at
    // this scale and keeps the two independent.
    const trend = (groupBy === "day" ? current : this.marginsByGroup(from, to, "day"))
      .map((r) => ({ date: r.id, revenue: r.revenue, cost: r.cost, profit: r.profit, marginPct: r.marginPct }));

    return {
      current,
      overallMarginPct: weightedMarginPct(cur.revenue, cur.cost),
      prevOverallMarginPct: weightedMarginPct(prev.revenue, prev.cost),
      trend
    };
  }

  getOrder(id: number): Order {
    const order = this.db
      .prepare("SELECT o.*, u.name as requestedByName FROM orders o LEFT JOIN users u ON o.requestedById = u.id WHERE o.id = ?")
      .get(id) as Order | null;
    if (!order) throw new Error(`Order ${id} not found`);
    return { ...this.parseOrder(order), items: this.listOrderItems(id) };
  }

  // Backs the printed order barcode's scan targets (see buildReceiptHtml's
  // ticketBarcodeSvg comment): Queue/History's "Scan order" button and
  // POS's "Scan to reorder" both decode a CODE128 barcode back to this
  // exact ticketNumber string, then look the order up here. ticketNumber
  // is UNIQUE (see the orders table schema), so this is always at most one row.
  getOrderByTicket(ticketNumber: string): Order | null {
    const order = this.db
      .prepare("SELECT o.*, u.name as requestedByName FROM orders o LEFT JOIN users u ON o.requestedById = u.id WHERE o.ticketNumber = ?")
      .get(ticketNumber) as Order | null;
    if (!order) return null;
    return { ...this.parseOrder(order), items: this.listOrderItems(order.id) };
  }

  updateOrderStatus(id: number, status: OrderStatus): Order {
    this.db.prepare("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.getOrder(id);
  }

  // ── Order Consolidation ──────────────────────────────────────────────────
  // Final packing/QA step: staff scans every line item's barcode to verify
  // it against the order, then a single consolidation barcode + receipt is
  // generated. Only 'Ready' (prepared, not yet handed over), not-yet-
  // consolidated orders are eligible — see the consolidatedAt column
  // comment in migrate().

  listOrdersPendingConsolidation(): Order[] {
    const sql = `
      SELECT o.id, o.ticketNumber, o.customerName, o.customerPhone, o.orderType,
             o.deliveryAddress, o.requestedTime, o.assignedTo, o.status, o.kitchenStatus, o.counterStatus,
             o.requestedById, o.createdAt, o.updatedAt, o.discountAmount, o.paymentMethod, o.cashTendered, o.crmContactId, o.customerEmail, o.paidAt, o.consolidatedAt, o.consolidationBarcode, u.name as requestedByName,
             oi.id as oi_id, oi.productId as oi_productId, oi.name as oi_name,
             oi.kg as oi_kg, oi.quantity as oi_quantity, oi.notes as oi_notes,
             oi.unitPrice as oi_unitPrice, oi.lineTotal as oi_lineTotal, oi.wantedPrice as oi_wantedPrice, oi.department as oi_dept, oi.costAtSale as oi_costAtSale, oi.scannedAt as oi_scannedAt
      FROM orders o
      LEFT JOIN users u ON o.requestedById = u.id
      LEFT JOIN order_items oi ON o.id = oi.orderId
      WHERE o.status = 'Ready' AND o.consolidatedAt IS NULL
      ORDER BY o.updatedAt ASC`;
    return Array.from(this.buildOrderMap(this.db.prepare(sql).all() as Record<string, unknown>[]).values());
  }

  // Resolves a scanned code to a product exactly like the existing
  // scan-to-add-to-order flow does (BarcodeAddModal/resolveBarcode in
  // src/ui/App.tsx): a scale weigh-label's PLU, or any other barcode
  // (real manufacturer, or this app's own "29"-prefixed auto-generated
  // one) matched as-is. Matches it against an UNSCANNED line on this
  // specific order — never silently ignored: a code that matches no line
  // at all, or matches one that's already checked off, both throw a
  // distinct, specific error rather than a generic failure.
  scanConsolidationItem(orderId: number, rawCode: string): OrderItem {
    const order = this.getOrder(orderId);
    if (order.consolidatedAt) throw new Error("This order has already been consolidated — no more scanning needed");

    const weigh = parseWeighBarcode(rawCode);
    const product = weigh ? this.getProductByItemCode(weigh.itemCode) : this.getProductByBarcode(rawCode);
    if (!product) throw new Error(`No product found for barcode "${rawCode}"`);

    const match = order.items.find((i) => i.productId === product.id && !i.scannedAt);
    if (!match) {
      const alreadyScanned = order.items.some((i) => i.productId === product.id && i.scannedAt);
      throw new Error(alreadyScanned ? `"${product.name}" has already been scanned for this order` : `"${product.name}" is not on this order`);
    }

    const now = new Date().toISOString();
    this.db.prepare("UPDATE order_items SET scannedAt = ? WHERE id = ?").run(now, match.id);
    return { ...match, scannedAt: now };
  }

  // Free-text lines (no productId) have no barcode that could ever be
  // scanned — same "nothing to check against, always allowed" treatment
  // the cost-price enforcement in routes/products.ts already gives them —
  // so they're excluded from what "every item scanned" requires here.
  finalizeConsolidation(orderId: number): Order {
    const order = this.getOrder(orderId);
    if (order.consolidatedAt) throw new Error("This order has already been consolidated");

    const scannable = order.items.filter((i) => i.productId != null);
    const unscanned = scannable.filter((i) => !i.scannedAt);
    if (unscanned.length > 0) {
      throw new Error(`${unscanned.length} of ${scannable.length} items still need to be scanned`);
    }

    const now = new Date().toISOString();
    const barcode = generateConsolidationBarcode(orderId);
    this.db.prepare("UPDATE orders SET consolidatedAt = ?, consolidationBarcode = ? WHERE id = ?").run(now, barcode, orderId);
    return this.getOrder(orderId);
  }

  // Appends one item to an already-created order — used by the "Scan
  // barcode" button on an in-progress ticket (as opposed to items added
  // while first building the order in OrderEntry). Blocked once an order
  // is Done, same as editing anything else about a finished ticket.
  addOrderItem(orderId: number, item: OrderItemInput): Order {
    const order = this.getOrder(orderId);
    if (order.status === "Done") throw new Error("Cannot add items to a completed order");
    const unitCost = item.productId ? this.getCurrentCost(item.productId) : null;
    const costAtSale = unitCost != null ? unitCost * (item.kg || item.quantity || 1) : null;
    this.db
      .prepare("INSERT INTO order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department, costAtSale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(orderId, item.productId ?? null, item.name.trim(), item.kg ?? null, item.quantity ?? null, item.notes.trim(), item.unitPrice ?? null, item.lineTotal ?? null, item.wantedPrice ?? null, item.department, costAtSale);
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
          costAtSale: row.oi_costAtSale as number | null,
          scannedAt: row.oi_scannedAt as string | null,
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
      .prepare("SELECT id, orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal, wantedPrice, department, costAtSale, scannedAt FROM order_items WHERE orderId = ? ORDER BY id ASC")
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
      if (!cols.includes("discountAmount")) this.db.exec("ALTER TABLE orders ADD COLUMN discountAmount REAL NOT NULL DEFAULT 0");
      if (!cols.includes("paymentMethod")) this.db.exec("ALTER TABLE orders ADD COLUMN paymentMethod TEXT NOT NULL DEFAULT 'cash'");
      if (!cols.includes("cashTendered")) this.db.exec("ALTER TABLE orders ADD COLUMN cashTendered REAL");
      if (!cols.includes("crmContactId")) this.db.exec("ALTER TABLE orders ADD COLUMN crmContactId TEXT REFERENCES crm_contacts(id)");
      if (!cols.includes("customerEmail")) this.db.exec("ALTER TABLE orders ADD COLUMN customerEmail TEXT");
      // Real, permanent "was this order actually paid" signal — set once,
      // at creation, only for a completeImmediately (POS) sale (see
      // createOrder below). Deliberately NOT derived from status/deptStatus:
      // a normal KOT ticket also ends up status='Done' once fulfilled,
      // which would otherwise be indistinguishable from a paid POS sale.
      // Stays null forever for a regular ticket until a real "mark as
      // paid" action exists — see buildOrderMessage's payment_status gap.
      if (!cols.includes("paidAt")) this.db.exec("ALTER TABLE orders ADD COLUMN paidAt TEXT");
      // Order Consolidation feature (see finalizeConsolidation): set
      // together, once, only after every line item has been individually
      // scanned and verified — a final packing/QA step, not a general
      // order-completion flag (see orders.status for that).
      if (!cols.includes("consolidatedAt")) this.db.exec("ALTER TABLE orders ADD COLUMN consolidatedAt TEXT");
      if (!cols.includes("consolidationBarcode")) this.db.exec("ALTER TABLE orders ADD COLUMN consolidationBarcode TEXT");
    }

    // Add brand/code/pageWidthMm/pageHeightMm to label_formats if missing
    // (existing databases created before Tower/Avery preset support and
    // landscape/Letter page sizes were added)
    const labelFormatsExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='label_formats'").get() as { n: number }).n > 0;
    if (labelFormatsExists) {
      const lfCols = (this.db.prepare("PRAGMA table_info(label_formats)").all() as { name: string }[]).map((c) => c.name);
      if (!lfCols.includes("brand")) this.db.exec("ALTER TABLE label_formats ADD COLUMN brand TEXT");
      if (!lfCols.includes("code")) this.db.exec("ALTER TABLE label_formats ADD COLUMN code TEXT");
      if (!lfCols.includes("pageWidthMm")) this.db.exec("ALTER TABLE label_formats ADD COLUMN pageWidthMm REAL");
      if (!lfCols.includes("pageHeightMm")) this.db.exec("ALTER TABLE label_formats ADD COLUMN pageHeightMm REAL");
    }

    // Add html_body to email_outbox if missing (existing databases created
    // before HTML/receipt emails were added)
    const emailOutboxExists = (this.db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='email_outbox'").get() as { n: number }).n > 0;
    if (emailOutboxExists) {
      const emailCols = (this.db.prepare("PRAGMA table_info(email_outbox)").all() as { name: string }[]).map((c) => c.name);
      if (!emailCols.includes("html_body")) this.db.exec("ALTER TABLE email_outbox ADD COLUMN html_body TEXT");
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
      if (!prodCols.includes("itemCode")) {
        this.db.exec("ALTER TABLE products ADD COLUMN itemCode TEXT");
        // One-time backfill for existing databases: a weighed product's
        // scale PLU used to be stored in `barcode` (see weighBarcode.ts's
        // old header comment, before this column existed) — move it to
        // itemCode and clear barcode, but ONLY when it's unambiguously a
        // bare 5-digit PLU, never a full 13-digit code. A weighed product
        // with a real 13-digit barcode (e.g. a pre-packaged item that
        // happens to be costed by weight) is left untouched rather than
        // guessed at — better to leave an admin to sort out a genuine
        // edge case than silently misclassify it.
        this.db.prepare("UPDATE products SET itemCode = barcode, barcode = NULL WHERE unitDefault != 'qty' AND barcode GLOB '[0-9][0-9][0-9][0-9][0-9]'").run();
      }
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
      if (!oiCols.includes("costAtSale")) this.db.exec("ALTER TABLE order_items ADD COLUMN costAtSale REAL");
      // Per-line checklist state for Order Consolidation's scan step (see
      // scanConsolidationItem) — lives on the row itself, not a separate
      // table, so it survives staff navigating away mid-scan and coming
      // back. Frozen once the parent order's consolidatedAt is set.
      if (!oiCols.includes("scannedAt")) this.db.exec("ALTER TABLE order_items ADD COLUMN scannedAt TEXT");
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
        itemCode TEXT,
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
        updatedAt TEXT NOT NULL,
        discountAmount REAL NOT NULL DEFAULT 0,
        paymentMethod TEXT NOT NULL DEFAULT 'cash',
        cashTendered REAL,
        crmContactId TEXT REFERENCES crm_contacts(id),
        customerEmail TEXT,
        paidAt TEXT,
        consolidatedAt TEXT,
        consolidationBarcode TEXT
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
        department TEXT NOT NULL DEFAULT 'counter',
        costAtSale REAL,
        scannedAt TEXT
      );

      -- ── CRM + WhatsApp automation ──────────────────────────────────────────
      -- Lives on each business's local instance, same offline-first model as
      -- the rest of NemenchPos — not centralized through the control plane.

      CREATE TABLE IF NOT EXISTS crm_contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT,
        phone_number TEXT NOT NULL UNIQUE,
        linked_customer_id TEXT,
        consent_status TEXT NOT NULL DEFAULT 'unknown',
        consent_recorded_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crm_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS crm_contact_tags (
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id),
        tag_id TEXT NOT NULL REFERENCES crm_tags(id),
        PRIMARY KEY (contact_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS crm_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id),
        direction TEXT NOT NULL,
        message_type TEXT NOT NULL,
        template_name TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        triggered_by TEXT,
        wa_message_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS whatsapp_outbox (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id),
        template_name TEXT,
        template_params TEXT,
        freeform_body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        -- Not in the original spec — added because the outbox worker (see
        -- server/whatsapp/outboxWorker.ts) needs to update "the
        -- corresponding crm_messages row" after sending (per spec section
        -- 5), and matching by contact_id + timing alone would risk
        -- updating the wrong row if two messages are queued for the same
        -- contact close together. Every outbound send creates its
        -- whatsapp_outbox row and crm_messages row together, linked here.
        crm_message_id TEXT REFERENCES crm_messages(id)
      );

      CREATE TABLE IF NOT EXISTS crm_automation_rules (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL UNIQUE,
        template_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      -- ── Email order notifications ────────────────────────────────────────
      -- Deliberately independent of the CRM/WhatsApp tables above — no
      -- consent/contact-resolution machinery, no Meta template-approval
      -- shape. A customer opts in by giving an email at checkout; whether
      -- it's sent at all is a single settings toggle (emailNotificationsEnabled)
      -- with a free-text subject/body template per event (also in settings,
      -- since there's no approval process constraining the shape the way
      -- WhatsApp templates are). See server/email/.
      CREATE TABLE IF NOT EXISTS email_outbox (
        id TEXT PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        to_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        html_body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      -- ── Email marketing list ────────────────────────────────────────────
      -- Every distinct customerEmail seen at checkout is auto-captured here
      -- (name + email, status defaulting to 'subscribed') so admins can send
      -- one-off news/deals campaigns without re-typing a mailing list by
      -- hand. Independent of email_outbox above (order receipts) and
      -- crm_contacts (phone/WhatsApp) — this is purely a name+email list,
      -- consulted only when composing a campaign (see server/email/campaign.ts).
      CREATE TABLE IF NOT EXISTS email_subscribers (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'subscribed',
        unsubscribe_token TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'order',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- ── Order-notification message templates ────────────────────────────
      -- Editable freeform bodies for the 4 pickup/delivery x paid/unpaid
      -- combinations (see server/whatsapp/orderMessages.ts's
      -- buildOrderMessage). NOT the same thing as the Meta-approved
      -- WhatsApp template catalog in whatsapp_templates (business profile)
      -- / crm_automation_rules — these are only legal to send as a
      -- freeform WhatsApp message within the 24h service window (Meta
      -- rejects business-initiated freeform sends outside it); outside the
      -- window, triggerOrderReadyMessage falls back to the existing
      -- Meta-approved order_ready template instead. Editable here anytime
      -- with no Meta resubmission needed — that's the tradeoff for only
      -- being usable in-window.
      CREATE TABLE IF NOT EXISTS order_message_templates (
        id TEXT PRIMARY KEY,
        fulfillment_type TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- ── Label format presets ─────────────────────────────────────────────
      -- Config for the "Print Labels" tab's two renderers (thermal
      -- single-label, a4_sheet grid) — physical dimensions in mm, not
      -- hardcoded in the client, so a format can be corrected/added
      -- without a code change. sheetCols through gapYMm are only
      -- meaningful for type='a4_sheet' (null for 'thermal', which is
      -- always exactly one label per physical print). pageWidthMm/
      -- pageHeightMm are null for the default 210x297 A4-portrait page;
      -- only set for a format that needs something else (US Letter, or an
      -- A4 sheet used in landscape) — see LabelFormat's schema comment in
      -- src/shared/types.ts.
      CREATE TABLE IF NOT EXISTS label_formats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        brand TEXT,
        code TEXT,
        widthMm REAL NOT NULL,
        heightMm REAL NOT NULL,
        sheetCols INTEGER,
        sheetRows INTEGER,
        marginTopMm REAL,
        marginLeftMm REAL,
        gapXMm REAL,
        gapYMm REAL,
        pageWidthMm REAL,
        pageHeightMm REAL,
        sortOrder INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone ON crm_contacts(phone_number);
      CREATE INDEX IF NOT EXISTS idx_crm_messages_contact ON crm_messages(contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_status ON whatsapp_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_orders_crm_contact ON orders(crmContactId);
      CREATE INDEX IF NOT EXISTS idx_email_subscribers_status ON email_subscribers(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_msg_tpl_combo ON order_message_templates(fulfillment_type, payment_status);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Single-row cache of the last-synced business profile from the
      -- control plane (see server/controlPlaneSync.ts) — id is pinned to 1
      -- via the CHECK constraint since there's only ever one profile for
      -- this instance. Read once into memory at startup and refreshed in
      -- memory whenever a sync succeeds; this table is the durable copy
      -- that survives a restart between syncs.
      CREATE TABLE IF NOT EXISTS local_profile_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        profile_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
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

      -- One row per cost change, not a single mutable field on products —
      -- "current cost" is the most recent row per product (see
      -- getCurrentCost), so a sale always has a historical cost to snapshot
      -- (order_items.costAtSale) even after the cost later changes again.
      CREATE TABLE IF NOT EXISTS product_cost_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        productId INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        costPerUnit REAL NOT NULL,
        effectiveFrom TEXT NOT NULL,
        createdById INTEGER REFERENCES users(id),
        createdAt TEXT NOT NULL
      );

      -- What % of a raw-intake product's received weight typically becomes
      -- each cut/sub-product (e.g. Whole Forequarter -> 45% Mince, 30%
      -- Steak) — doesn't need to sum to 100%, the remainder is untracked
      -- bone/trim/waste. One row per (rawProductId, subProductId) pair.
      CREATE TABLE IF NOT EXISTS product_yield_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rawProductId INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        subProductId INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        yieldPct REAL NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(rawProductId, subProductId)
      );

      -- Created automatically when a Weigh-In line is logged for a raw
      -- product with estimates configured — but this alone changes no
      -- stock. Only applyYieldConversion (an explicit, separate action)
      -- actually adjusts the sub-products' stock; dismissing one changes
      -- nothing either. "status" tracks which of the three has happened.
      CREATE TABLE IF NOT EXISTS pending_yield_conversions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        weighInLineId INTEGER REFERENCES weigh_in_lines(id) ON DELETE SET NULL,
        rawProductId INTEGER NOT NULL REFERENCES products(id),
        weightKgReceived REAL NOT NULL,
        locationId INTEGER NOT NULL REFERENCES stock_locations(id),
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt TEXT NOT NULL,
        resolvedAt TEXT,
        resolvedById INTEGER REFERENCES users(id)
      );

      -- The estimated breakdown for one pending conversion — yieldPct is
      -- snapshotted at creation time (so a later change to
      -- product_yield_estimates doesn't retroactively alter an
      -- already-queued conversion), and estimatedKg can be edited by
      -- whoever reviews it before applying (the estimate is a starting
      -- point, not a guarantee the actual cutting matches it exactly).
      CREATE TABLE IF NOT EXISTS pending_yield_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversionId INTEGER NOT NULL REFERENCES pending_yield_conversions(id) ON DELETE CASCADE,
        subProductId INTEGER NOT NULL REFERENCES products(id),
        estimatedKg REAL NOT NULL,
        yieldPct REAL NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_cost_product_effective ON product_cost_history(productId, effectiveFrom DESC);
      CREATE INDEX IF NOT EXISTS idx_yield_est_raw ON product_yield_estimates(rawProductId);
      CREATE INDEX IF NOT EXISTS idx_pending_yield_status ON pending_yield_conversions(status);
      CREATE INDEX IF NOT EXISTS idx_pending_yield_items_conv ON pending_yield_items(conversionId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_barcode ON products(barcode) WHERE barcode IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_item_code ON products(itemCode) WHERE itemCode IS NOT NULL;
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
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('labelPrinter', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('historyDays', '30')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('siteName', 'NemenchPos')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('logoUrl', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('themeColor', '')").run();
    // Defaults to "not registered" on every fresh install, deliberately —
    // this app has no way to know a new deployment's actual VAT status, and
    // presuming "registered" would risk a shop that isn't VAT-registered
    // printing a VAT breakdown/number it has no right to. Flip it on
    // (Settings > Tax & Legal) once the real number is known.
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vatRegistered', 'false')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vatNumber', '')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('businessAddress', '')").run();
    // {closing_time} placeholder source for order_message_templates below —
    // a business-wide fact, not per-order, so it lives here rather than on
    // the order. Blank by default; buildOrderMessage falls back to a
    // generic phrase if it's never set.
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('closingTime', '')").run();
    // Which label_formats.id is physically loaded in the till's sticker
    // printer right now — lets Print Labels default new sessions straight
    // to the right sheet instead of everyone re-picking it every time.
    // Deliberately blank by default rather than pre-picking a specific
    // Tower/Avery code: this is site-specific (whatever sheet a given
    // shop actually bought), so guessing wrong would be worse than
    // leaving it unset until an admin picks one in Settings > Printing.
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('activeLabelSheetFormat', '')").run();
    // Blank means "auto" — see getQuickPickProducts for the fallback to
    // recent-sales-frequency when no admin has pinned anything.
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('posQuickPickIds', '')").run();

    // Seed default order-notification message templates (see the
    // order_message_templates schema comment above) — INSERT OR IGNORE
    // against the unique (fulfillment_type, payment_status) index, same
    // idempotent-on-every-boot pattern as the settings defaults just
    // above, so this backfills existing installs upgrading into this
    // feature (unlike seed(), which only ever runs once, on a database
    // with zero users) without ever overwriting an admin's own edits.
    const seedOrderMessageTemplate = this.db.prepare(
      "INSERT OR IGNORE INTO order_message_templates (id, fulfillment_type, payment_status, body, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    const nowIso = new Date().toISOString();
    for (const [id, fulfillmentType, paymentStatus, body] of [
      ["pickup_ready_paid", "pickup", "paid",
        "Hi {customer_name}, your order at {business_name} is ready for collection.\n\nOrder #{order_number}\nTotal: R{amount} - Paid ✅\n\n📍 {business_address}\n🕐 Collect anytime before {closing_time}\n\nThanks for your order!"],
      ["pickup_ready_unpaid", "pickup", "unpaid",
        "Hi {customer_name}, your order at {business_name} is ready for collection.\n\nOrder #{order_number}\nTotal due: R{amount} - Pay on collection\n\n📍 {business_address}\n🕐 Collect anytime before {closing_time}\n\nSee you soon!"],
      ["delivery_out_paid", "delivery", "paid",
        "Hi {customer_name}, your order from {business_name} is on its way!\n\nOrder #{order_number}\nTotal: R{amount} - Paid ✅\n\n🚚 Estimated arrival: {eta}\n📍 Delivering to: {delivery_address}\n\nThanks for your order!"],
      ["delivery_out_unpaid", "delivery", "unpaid",
        "Hi {customer_name}, your order from {business_name} is on its way!\n\nOrder #{order_number}\nTotal due: R{amount} - Pay on delivery\n\n🚚 Estimated arrival: {eta}\n📍 Delivering to: {delivery_address}\n\nHave your payment ready for the driver."]
    ]) {
      seedOrderMessageTemplate.run(id, fulfillmentType, paymentStatus, body, nowIso);
    }

    // Seed default label formats — INSERT OR IGNORE against the primary
    // key, same idempotent-on-every-boot pattern as order_message_templates
    // just above, so this backfills existing installs without clobbering
    // an admin's own edits (or an admin's own custom formats — this only
    // ever inserts these specific ids, never touches anyone else's rows).
    //
    // The "a4_XX" presets are all standard Avery A4 sheet layouts, each
    // sold under the same physical dimensions by other brands too (Tower,
    // Ryman, Rapesco, Q-Connet, HERMA, etc. all publish label sheets that
    // are pin-compatible with these Avery codes — "Avery-compatible" is
    // the industry-standard way these are described, not an Avery-specific
    // format). a4_8/10/14/16/18/48 were cross-checked against multiple
    // independent published spec sheets for their Avery code
    // (L7165/L7173/L7163/L7162/L7161/L7636) and the margins/gaps satisfy
    // cols*width + gaps ≈ 210mm and rows*height ≈ 297mm exactly, so these
    // should print true out of the box. a4_21/24/65 predate this and
    // haven't been re-verified the same way — if a sheet comes out
    // shifted, nudge its marginTopMm/marginLeftMm by a mm or two, same
    // caveat that applies to any label-template software.
    //
    // The "tw_XX" (Tower, the South African stationery brand) presets are
    // built from Tower's published label-size + count-per-sheet chart.
    // Where a Tower code's size/count exactly matches an Avery code we'd
    // already cross-checked above (e.g. tw_w108 = a4_21/L7160, tw_w237 =
    // a4_14/L7163), its margins/gaps are reused directly since they're the
    // same physical layout under a different brand name. Every other
    // tw_XX's margins are only computed from "cols*width + gaps ≈ 210mm,
    // rows*height ≈ 297mm assuming a 0mm gap" — NOT verified against a
    // real printed sheet or Tower's own official template, since none of
    // those were available to check against here. TODO: before a bulk
    // print run on any tw_XX format that doesn't cite a matching Avery
    // code below, print one test sheet against real Tower stock first and
    // nudge marginTopMm/marginLeftMm/gapXMm if it's off.
    //
    // The "av_XX" (Avery, international/US Letter) presets are for
    // reference/compatibility only — note pageWidthMm/pageHeightMm are
    // set to US Letter (215.9 x 279.4mm), NOT A4, since that's the actual
    // paper size these Avery codes are designed for; printing one on A4
    // paper will NOT line up. Margins follow Avery's well-documented US
    // Letter convention (0.5in top/bottom, 0.25in or 0.19in sides, small
    // column gaps) cross-checked against the label's own published
    // width/height/count math; av_5167's side margin is a rougher
    // estimate (TODO: verify against Avery's own template before a bulk
    // run — its 4-narrow-column layout is less standardized than the
    // others here).
    const seedLabelFormat = this.db.prepare(
      "INSERT OR IGNORE INTO label_formats (id, name, type, brand, code, widthMm, heightMm, sheetCols, sheetRows, marginTopMm, marginLeftMm, gapXMm, gapYMm, pageWidthMm, pageHeightMm, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const f of [
      { id: "thermal_30x20",  name: "Thermal 30 x 20mm",             type: "thermal",  brand: null,    code: null,    w: 30,   h: 20,   cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 0 },
      { id: "thermal_40x30",  name: "Thermal 40 x 30mm",             type: "thermal",  brand: null,    code: null,    w: 40,   h: 30,   cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 1 },
      { id: "thermal_50x30",  name: "Thermal 50 x 30mm",             type: "thermal",  brand: null,    code: null,    w: 50,   h: 30,   cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 2 },
      { id: "thermal_58x40",  name: "Thermal 58 x 40mm",             type: "thermal",  brand: null,    code: null,    w: 58,   h: 40,   cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 3 },
      { id: "thermal_100x50", name: "Thermal 100 x 50mm",            type: "thermal",  brand: null,    code: null,    w: 100,  h: 50,   cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 4 },
      { id: "thermal_100x150",name: "Thermal 100 x 150mm (shipping)",type: "thermal",  brand: null,    code: null,    w: 100,  h: 150,  cols: null, rows: null, mt: null,  ml: null, gx: null, gy: null, pw: null,  ph: null,  sort: 5 },

      { id: "a4_6",  name: "A4 sheet - 6/sheet (L7166)",  type: "a4_sheet", brand: "Avery", code: "L7166", w: 99.1, h: 93.1, cols: 2, rows: 3,  mt: 8.85,  ml: 4.4,  gx: 3,   gy: 0, pw: null, ph: null, sort: 10 },
      { id: "a4_8",  name: "A4 sheet - 8/sheet (L7165)",  type: "a4_sheet", brand: "Avery", code: "L7165", w: 99.1, h: 67.7, cols: 2, rows: 4,  mt: 13.1,  ml: 4.65, gx: 2.5, gy: 0, pw: null, ph: null, sort: 11 },
      { id: "a4_10", name: "A4 sheet - 10/sheet (L7173)", type: "a4_sheet", brand: "Avery", code: "L7173", w: 99.1, h: 57.3, cols: 2, rows: 5,  mt: 5.25,  ml: 4.9,  gx: 2,   gy: 0, pw: null, ph: null, sort: 12 },
      { id: "a4_14", name: "A4 sheet - 14/sheet (L7163)", type: "a4_sheet", brand: "Avery", code: "L7163", w: 99.1, h: 38.1, cols: 2, rows: 7,  mt: 15.15, ml: 4.9,  gx: 2,   gy: 0, pw: null, ph: null, sort: 13 },
      { id: "a4_16", name: "A4 sheet - 16/sheet (L7162)", type: "a4_sheet", brand: "Avery", code: "L7162", w: 99.1, h: 33.9, cols: 2, rows: 8,  mt: 12.9,  ml: 4.9,  gx: 2,   gy: 0, pw: null, ph: null, sort: 14 },
      { id: "a4_18", name: "A4 sheet - 18/sheet (L7161)", type: "a4_sheet", brand: "Avery", code: "L7161", w: 63.5, h: 46.6, cols: 3, rows: 6,  mt: 8.7,   ml: 7.25, gx: 2.5, gy: 0, pw: null, ph: null, sort: 15 },
      { id: "a4_21", name: "A4 sheet - 21/sheet (L7160)", type: "a4_sheet", brand: "Avery", code: "L7160", w: 63.5, h: 38.1, cols: 3, rows: 7,  mt: 15.15, ml: 7.2,  gx: 2.5, gy: 0, pw: null, ph: null, sort: 16 },
      { id: "a4_24", name: "A4 sheet - 24/sheet (L7159)", type: "a4_sheet", brand: "Avery", code: "L7159", w: 63.5, h: 33.9, cols: 3, rows: 8,  mt: 13.5,  ml: 7.2,  gx: 2.5, gy: 0, pw: null, ph: null, sort: 17 },
      { id: "a4_48", name: "A4 sheet - 48/sheet (L7636)", type: "a4_sheet", brand: "Avery", code: "L7636", w: 45.7, h: 21.2, cols: 4, rows: 12, mt: 21.3,  ml: 9.85, gx: 2.5, gy: 0, pw: null, ph: null, sort: 18 },
      { id: "a4_65", name: "A4 sheet - 65/sheet (L7651)", type: "a4_sheet", brand: "Avery", code: "L7651", w: 38.1, h: 21.2, cols: 5, rows: 13, mt: 15.1,  ml: 4.8,  gx: 2.5, gy: 0, pw: null, ph: null, sort: 19 },

      // ── Tower (South Africa) ──────────────────────────────────────────
      { id: "tw_w107", name: "Tower W107 - 65/sheet",  type: "a4_sheet", brand: "Tower", code: "W107", w: 38.1, h: 21.2, cols: 5, rows: 13, mt: 15.1,  ml: 4.8,  gx: 2.5, gy: 0, pw: null, ph: null, sort: 30 }, // = a4_65/L7651
      { id: "tw_w115", name: "Tower W115 - 45/sheet",  type: "a4_sheet", brand: "Tower", code: "W115", w: 38.5, h: 29.9, cols: 5, rows: 9,  mt: 13.95, ml: 8.75, gx: 0,   gy: 0, pw: null, ph: null, sort: 31 }, // TODO: unverified, calibrate
      { id: "tw_w239", name: "Tower W239 - 39/sheet",  type: "a4_sheet", brand: "Tower", code: "W239", w: 66,   h: 20.69,cols: 3, rows: 13, mt: 14.02, ml: 6,    gx: 0,   gy: 0, pw: null, ph: null, sort: 32 }, // TODO: unverified, calibrate
      { id: "tw_w100", name: "Tower W100 - 24/sheet",  type: "a4_sheet", brand: "Tower", code: "W100", w: 70,   h: 37,   cols: 3, rows: 8,  mt: 0.5,   ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 33 }, // TODO: unverified, calibrate (near-zero side margin is suspicious — likely needs a small gap in reality)
      { id: "tw_w109", name: "Tower W109 - 24/sheet",  type: "a4_sheet", brand: "Tower", code: "W109", w: 64,   h: 33.9, cols: 3, rows: 8,  mt: 12.9,  ml: 9,    gx: 0,   gy: 0, pw: null, ph: null, sort: 34 }, // TODO: unverified, calibrate
      { id: "tw_w110", name: "Tower W110 - 24/sheet",  type: "a4_sheet", brand: "Tower", code: "W110", w: 35,   h: 70,   cols: 6, rows: 4,  mt: 8.5,   ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 35 }, // TODO: unverified, calibrate
      { id: "tw_w108", name: "Tower W108 - 21/sheet",  type: "a4_sheet", brand: "Tower", code: "W108", w: 63.5, h: 38.1, cols: 3, rows: 7,  mt: 15.15, ml: 7.2,  gx: 2.5, gy: 0, pw: null, ph: null, sort: 36 }, // = a4_21/L7160
      { id: "tw_w112", name: "Tower W112 - 18/sheet",  type: "a4_sheet", brand: "Tower", code: "W112", w: 63.5, h: 46.6, cols: 3, rows: 6,  mt: 8.7,   ml: 7.25, gx: 2.5, gy: 0, pw: null, ph: null, sort: 37 }, // = a4_18/L7161
      { id: "tw_w101", name: "Tower W101 - 16/sheet",  type: "a4_sheet", brand: "Tower", code: "W101", w: 105,  h: 37,   cols: 2, rows: 8,  mt: 0.5,   ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 38 }, // TODO: unverified, calibrate (near-zero side margin is suspicious)
      // W111 is 35x105mm labels, 16/sheet — that grid (8 cols x 2 rows)
      // only fits an A4 sheet used in LANDSCAPE (297mm wide); it cannot
      // fit any valid cols x rows grid on a portrait A4 page, so this is
      // the one Tower preset that needs pageWidthMm/pageHeightMm swapped.
      { id: "tw_w111", name: "Tower W111 - 16/sheet (landscape)", type: "a4_sheet", brand: "Tower", code: "W111", w: 35, h: 105, cols: 8, rows: 2, mt: 0, ml: 8.5, gx: 0, gy: 0, pw: 297, ph: 210, sort: 39 }, // TODO: unverified, calibrate
      { id: "tw_w237", name: "Tower W237 - 14/sheet",  type: "a4_sheet", brand: "Tower", code: "W237", w: 99,   h: 38.1, cols: 2, rows: 7,  mt: 15.15, ml: 4.9,  gx: 2,   gy: 0, pw: null, ph: null, sort: 40 }, // = a4_14/L7163
      { id: "tw_w102", name: "Tower W102 - 12/sheet",  type: "a4_sheet", brand: "Tower", code: "W102", w: 101,  h: 45,   cols: 2, rows: 6,  mt: 13.5,  ml: 4,    gx: 0,   gy: 0, pw: null, ph: null, sort: 41 }, // TODO: unverified, calibrate
      { id: "tw_w233", name: "Tower W233 - 12/sheet",  type: "a4_sheet", brand: "Tower", code: "W233", w: 63.5, h: 72,   cols: 3, rows: 4,  mt: 4.5,   ml: 9.75, gx: 0,   gy: 0, pw: null, ph: null, sort: 42 }, // TODO: unverified, calibrate
      { id: "tw_w236", name: "Tower W236 - 12/sheet",  type: "a4_sheet", brand: "Tower", code: "W236", w: 105,  h: 49,   cols: 2, rows: 6,  mt: 1.5,   ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 43 }, // TODO: unverified, calibrate
      { id: "tw_w119", name: "Tower W119 - 10/sheet",  type: "a4_sheet", brand: "Tower", code: "W119", w: 99,   h: 57,   cols: 2, rows: 5,  mt: 5.25,  ml: 4.9,  gx: 2,   gy: 0, pw: null, ph: null, sort: 44 }, // = a4_10/L7173
      { id: "tw_w103", name: "Tower W103 - 8/sheet",   type: "a4_sheet", brand: "Tower", code: "W103", w: 101,  h: 70,   cols: 2, rows: 4,  mt: 8.5,   ml: 4,    gx: 0,   gy: 0, pw: null, ph: null, sort: 45 }, // TODO: unverified, calibrate
      { id: "tw_w234", name: "Tower W234 - 8/sheet",   type: "a4_sheet", brand: "Tower", code: "W234", w: 105,  h: 74,   cols: 2, rows: 4,  mt: 0.5,   ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 46 }, // TODO: unverified, calibrate
      { id: "tw_w120", name: "Tower W120 - 6/sheet",   type: "a4_sheet", brand: "Tower", code: "W120", w: 99,   h: 93.1, cols: 2, rows: 3,  mt: 8.85,  ml: 4.4,  gx: 3,   gy: 0, pw: null, ph: null, sort: 47 }, // = a4_6/L7166
      { id: "tw_w104", name: "Tower W104 - 4/sheet",   type: "a4_sheet", brand: "Tower", code: "W104", w: 98,   h: 139,  cols: 2, rows: 2,  mt: 9.5,   ml: 7,    gx: 0,   gy: 0, pw: null, ph: null, sort: 48 }, // TODO: unverified, calibrate
      { id: "tw_w114", name: "Tower W114 - 4/sheet",   type: "a4_sheet", brand: "Tower", code: "W114", w: 105,  h: 149,  cols: 2, rows: 2,  mt: 0,     ml: 0,    gx: 0,   gy: 0, pw: null, ph: null, sort: 49 }, // TODO: unverified, calibrate — published height (149x2=298mm) is 1mm over nominal A4 (297mm), normal rounding for this kind of sheet
      { id: "tw_w105", name: "Tower W105 - 2/sheet",   type: "a4_sheet", brand: "Tower", code: "W105", w: 199.5,h: 145.5,cols: 1, rows: 2,  mt: 3,     ml: 5.25, gx: 0,   gy: 0, pw: null, ph: null, sort: 50 }, // TODO: unverified, calibrate
      { id: "tw_w106", name: "Tower W106/TM106 - 1/sheet (full page)", type: "a4_sheet", brand: "Tower", code: "W106/TM106", w: 210, h: 297, cols: 1, rows: 1, mt: 0, ml: 0, gx: 0, gy: 0, pw: null, ph: null, sort: 51 },
      // Per-sheet count wasn't given for these — computed as the max grid
      // that fits the page with a 0mm gap (same TODO/unverified caveat).
      { id: "tw_w240", name: "Tower W240 - 176/sheet",  type: "a4_sheet", brand: "Tower", code: "W240", w: 26,   h: 13.5, cols: 8, rows: 22, mt: 0,     ml: 1,    gx: 0, gy: 0, pw: null, ph: null, sort: 70 }, // TODO: unverified, calibrate — per-sheet count computed (not given)
      { id: "tw_w225", name: "Tower W225 - 104/sheet",  type: "a4_sheet", brand: "Tower", code: "W225", w: 46,   h: 11.1, cols: 4, rows: 26, mt: 4.2,   ml: 13,   gx: 0, gy: 0, pw: null, ph: null, sort: 71 }, // TODO: unverified, calibrate — per-sheet count computed (not given)
      { id: "tw_w121", name: "Tower W121 - 16/sheet",   type: "a4_sheet", brand: "Tower", code: "W121", w: 99,   h: 33.9, cols: 2, rows: 8,  mt: 12.9,  ml: 6,    gx: 0, gy: 0, pw: null, ph: null, sort: 72 }, // TODO: unverified, calibrate — per-sheet count computed (not given); ≈ a4_16/L7162
      { id: "tw_w223", name: "Tower W223 - 12/sheet",   type: "a4_sheet", brand: "Tower", code: "W223", w: 76.2, h: 46,   cols: 2, rows: 6,  mt: 10.5,  ml: 28.8, gx: 0, gy: 0, pw: null, ph: null, sort: 73 }, // TODO: unverified, calibrate
      { id: "tw_w227", name: "Tower W227 - 10/sheet",   type: "a4_sheet", brand: "Tower", code: "W227", w: 70,   h: 52,   cols: 2, rows: 5,  mt: 18.5,  ml: 35,   gx: 0, gy: 0, pw: null, ph: null, sort: 74 }, // TODO: unverified, calibrate
      { id: "tw_w235", name: "Tower W235 - 9/sheet",    type: "a4_sheet", brand: "Tower", code: "W235", w: 67,   h: 90,   cols: 3, rows: 3,  mt: 13.5,  ml: 4.5,  gx: 0, gy: 0, pw: null, ph: null, sort: 75 }, // TODO: unverified, calibrate
      { id: "tw_w221", name: "Tower W221 - 8/sheet",    type: "a4_sheet", brand: "Tower", code: "W221", w: 70,   h: 70,   cols: 2, rows: 4,  mt: 8.5,   ml: 35,   gx: 0, gy: 0, pw: null, ph: null, sort: 76 }, // TODO: unverified, calibrate
      // W232 (139x99.1mm, 4/sheet) only fits an A4 sheet used in
      // LANDSCAPE, same reasoning as W111 above.
      { id: "tw_w232", name: "Tower W232 - 4/sheet (landscape)", type: "a4_sheet", brand: "Tower", code: "W232", w: 139, h: 99.1, cols: 2, rows: 2, mt: 5.9, ml: 9.5, gx: 0, gy: 0, pw: 297, ph: 210, sort: 77 }, // TODO: unverified, calibrate
      // Round labels (W228/W116/W117/W118): this app's label renderer
      // only draws rectangular cells (see buildLabelCellHtml) — there's
      // no round-label-specific rendering, so these are stored using the
      // circle's diameter as a square bounding box for grid math. The
      // printed content will fill that square, not clipped to a circle —
      // fine for cutting a printed sheet against a physical round
      // sticker sheet (the backing paper's circles are what actually
      // define the visible shape), but be aware the rendered rectangle
      // itself isn't round.
      { id: "tw_w228", name: "Tower W228 - 2/sheet (Ø117mm CD/DVD)", type: "a4_sheet", brand: "Tower", code: "W228", w: 117, h: 117, cols: 1, rows: 2, mt: 31.5, ml: 46.5, gx: 0, gy: 0, pw: null, ph: null, sort: 78 }, // TODO: unverified, calibrate — round label, bounding-box only (see comment above)
      { id: "tw_w116", name: "Tower W116 - 54/sheet (Ø32mm round)",   type: "a4_sheet", brand: "Tower", code: "W116", w: 32,  h: 32,  cols: 6, rows: 9,  mt: 4.5,  ml: 9,    gx: 0, gy: 0, pw: null, ph: null, sort: 79 }, // TODO: unverified, calibrate — round label, bounding-box only; per-sheet count computed (not given)
      { id: "tw_w117", name: "Tower W117 - 20/sheet (Ø50mm round)",   type: "a4_sheet", brand: "Tower", code: "W117", w: 50,  h: 50,  cols: 4, rows: 5,  mt: 23.5, ml: 5,    gx: 0, gy: 0, pw: null, ph: null, sort: 80 }, // TODO: unverified, calibrate — round label, bounding-box only; per-sheet count computed (not given)
      { id: "tw_w118", name: "Tower W118 - 6/sheet (Ø80mm round)",    type: "a4_sheet", brand: "Tower", code: "W118", w: 80,  h: 80,  cols: 2, rows: 3,  mt: 28.5, ml: 25,   gx: 0, gy: 0, pw: null, ph: null, sort: 81 }, // TODO: unverified, calibrate — round label, bounding-box only; per-sheet count computed (not given)
      { id: "tw_w330", name: "Tower W330 - 4/sheet (lever arch)",     type: "a4_sheet", brand: "Tower", code: "W330", w: 200, h: 60,  cols: 1, rows: 4,  mt: 28.5, ml: 5,    gx: 0, gy: 0, pw: null, ph: null, sort: 82 }, // TODO: unverified, calibrate
      { id: "tw_w231", name: "Tower W231 - 1/sheet",    type: "a4_sheet", brand: "Tower", code: "W231", w: 199.6,h: 289,  cols: 1, rows: 1,  mt: 4,     ml: 5.2,  gx: 0, gy: 0, pw: null, ph: null, sort: 83 }, // TODO: unverified, calibrate

      // ── Avery (international / US Letter — NOT A4, see comment above) ──
      { id: "av_5160", name: "Avery 5160/8160 - 30/sheet (US Letter)", type: "a4_sheet", brand: "Avery", code: "5160/8160", w: 66.7,  h: 25.4, cols: 3, rows: 10, mt: 12.7, ml: 4.8,  gx: 3.2, gy: 0, pw: 215.9, ph: 279.4, sort: 60 },
      { id: "av_5163", name: "Avery 5163/8163 - 10/sheet (US Letter)", type: "a4_sheet", brand: "Avery", code: "5163/8163", w: 101.6, h: 50.8, cols: 2, rows: 5,  mt: 12.7, ml: 6.35, gx: 0,   gy: 0, pw: 215.9, ph: 279.4, sort: 61 },
      { id: "av_5164", name: "Avery 5164 - 6/sheet (US Letter)",       type: "a4_sheet", brand: "Avery", code: "5164",      w: 101.6, h: 84.7, cols: 2, rows: 3,  mt: 12.65,ml: 6.35, gx: 0,   gy: 0, pw: 215.9, ph: 279.4, sort: 62 },
      { id: "av_5167", name: "Avery 5167 - 80/sheet (US Letter)",      type: "a4_sheet", brand: "Avery", code: "5167",      w: 44.5,  h: 12.7, cols: 4, rows: 20, mt: 12.7, ml: 18.95,gx: 0,   gy: 0, pw: 215.9, ph: 279.4, sort: 63 }, // TODO: side margin is a rough estimate, not cross-checked — verify against Avery's own template before a bulk run
      // Requested as "33.9 x 66.7mm" — that doesn't tile onto any A4 or
      // Letter page at 14/sheet (checked both ways round). Avery's own
      // published spec for 5262/8462 is a 1-1/3" x 4" (33.9 x 101.6mm)
      // address label used LANDSCAPE (101.6mm wide x 33.9mm tall), 2
      // columns x 7 rows = 14/sheet — used that verified size/orientation
      // instead of the requested figure, which would never have printed
      // correctly.
      { id: "av_5262", name: "Avery 5262/8462 - 14/sheet (US Letter)", type: "a4_sheet", brand: "Avery", code: "5262/8462", w: 101.6, h: 33.9, cols: 2, rows: 7, mt: 21.05, ml: 6.35, gx: 0, gy: 0, pw: 215.9, ph: 279.4, sort: 64 }
      // Deliberately NOT adding a separate "Avery 7160" entry: every
      // independent source checked for this says "7160" is simply
      // Avery's own shorthand for L7160 — the same 63.5x38.1mm,
      // 21-per-sheet A4 layout already seeded above as a4_21/tw_w108.
      // There's no genuine distinct 30-per-sheet A4 product by that name
      // (that count only exists on 5160's US Letter page) — adding one
      // under a fabricated size would just be wrong data.
    ]) {
      seedLabelFormat.run(f.id, f.name, f.type, f.brand, f.code, f.w, f.h, f.cols, f.rows, f.mt, f.ml, f.gx, f.gy, f.pw, f.ph, f.sort, nowIso);
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // ── Control plane profile cache ─────────────────────────────────────────────
  // See server/controlPlaneSync.ts — these are the only two operations it
  // needs against the local DB, kept here for consistency with every other
  // table in this file rather than in a separate data-access module.

  getCachedProfile(): { profile_json: string; synced_at: string } | null {
    return this.db.prepare("SELECT profile_json, synced_at FROM local_profile_cache WHERE id = 1").get() as
      { profile_json: string; synced_at: string } | null;
  }

  setCachedProfile(profileJson: string, syncedAt: string): void {
    this.db
      .prepare(`
        INSERT INTO local_profile_cache (id, profile_json, synced_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, synced_at = excluded.synced_at`)
      .run(profileJson, syncedAt);
  }

  // ── CRM + WhatsApp automation ────────────────────────────────────────────────

  private static readonly CONTACT_COLUMNS = `
    c.id, c.full_name as fullName, c.phone_number as phoneNumber,
    c.linked_customer_id as linkedCustomerId, c.consent_status as consentStatus,
    c.consent_recorded_at as consentRecordedAt, c.notes, c.created_at as createdAt, c.updated_at as updatedAt`;

  private attachTags(contact: Omit<CrmContact, "tags">): CrmContact {
    const tags = this.db
      .prepare("SELECT t.name FROM crm_tags t JOIN crm_contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? ORDER BY t.name")
      .all(contact.id) as { name: string }[];
    return { ...contact, tags: tags.map((t) => t.name) };
  }

  getContact(id: string): CrmContact | null {
    const row = this.db.prepare(`SELECT ${KotDatabase.CONTACT_COLUMNS} FROM crm_contacts c WHERE c.id = ?`).get(id) as
      Omit<CrmContact, "tags"> | undefined;
    return row ? this.attachTags(row) : null;
  }

  findContactByPhone(phoneNumber: string): CrmContact | null {
    const row = this.db.prepare(`SELECT ${KotDatabase.CONTACT_COLUMNS} FROM crm_contacts c WHERE c.phone_number = ?`).get(phoneNumber) as
      Omit<CrmContact, "tags"> | undefined;
    return row ? this.attachTags(row) : null;
  }

  // Used by both POS checkout (an optional "Customer number" field — see
  // createOrder below) and the inbound webhook (server/routes/
  // whatsappWebhook.ts) — the two places a phone number arrives without
  // already knowing whether it belongs to an existing contact. A new
  // contact always starts consent_status='unknown', full_name null; never
  // silently guesses a name from anywhere.
  resolveOrCreateContactByPhone(phoneNumber: string): CrmContact {
    const existing = this.findContactByPhone(phoneNumber);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO crm_contacts (id, full_name, phone_number, consent_status, created_at, updated_at) VALUES (?, NULL, ?, 'unknown', ?, ?)")
      .run(id, phoneNumber, now, now);
    return this.getContact(id)!;
  }

  // Search matches name, phone, or tag name (case-insensitive substring) —
  // deliberately not a full-text index given the scale of a single
  // butchery's contact list.
  listContacts(search?: string): CrmContact[] {
    let rows: Omit<CrmContact, "tags">[];
    if (search?.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      rows = this.db
        .prepare(`
          SELECT DISTINCT ${KotDatabase.CONTACT_COLUMNS}
          FROM crm_contacts c
          LEFT JOIN crm_contact_tags ct ON ct.contact_id = c.id
          LEFT JOIN crm_tags t ON t.id = ct.tag_id
          WHERE lower(COALESCE(c.full_name, '')) LIKE ? OR c.phone_number LIKE ? OR lower(COALESCE(t.name, '')) LIKE ?
          ORDER BY c.full_name COLLATE NOCASE, c.phone_number`)
        .all(q, q, q) as Omit<CrmContact, "tags">[];
    } else {
      rows = this.db
        .prepare(`SELECT ${KotDatabase.CONTACT_COLUMNS} FROM crm_contacts c ORDER BY c.full_name COLLATE NOCASE, c.phone_number`)
        .all() as Omit<CrmContact, "tags">[];
    }
    return rows.map((r) => this.attachTags(r));
  }

  updateContact(id: string, input: CrmContactInput): CrmContact {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      if ("fullName" in input || "notes" in input) {
        const current = this.getContact(id);
        if (!current) throw new Error(`Contact ${id} not found`);
        this.db
          .prepare("UPDATE crm_contacts SET full_name = ?, notes = ?, updated_at = ? WHERE id = ?")
          .run(input.fullName !== undefined ? input.fullName : current.fullName, input.notes !== undefined ? input.notes : current.notes, now, id);
      }
      if (input.tags) this.setContactTags(id, input.tags);
    });
    run();
    const contact = this.getContact(id);
    if (!contact) throw new Error(`Contact ${id} not found`);
    return contact;
  }

  // Replace-all tag assignment, creating any tag that doesn't exist yet —
  // same pattern as setYieldEstimates: the list is short, diffing
  // add/remove client-side isn't worth it.
  setContactTags(contactId: string, tagNames: string[]): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM crm_contact_tags WHERE contact_id = ?").run(contactId);
      for (const name of tagNames) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        let tag = this.db.prepare("SELECT id FROM crm_tags WHERE name = ? COLLATE NOCASE").get(trimmed) as { id: string } | undefined;
        if (!tag) {
          const tagId = randomUUID();
          this.db.prepare("INSERT INTO crm_tags (id, name) VALUES (?, ?)").run(tagId, trimmed);
          tag = { id: tagId };
        }
        this.db.prepare("INSERT OR IGNORE INTO crm_contact_tags (contact_id, tag_id) VALUES (?, ?)").run(contactId, tag.id);
      }
    });
    run();
  }

  listTags(): CrmTag[] {
    return this.db.prepare("SELECT id, name FROM crm_tags ORDER BY name").all() as CrmTag[];
  }

  // Timestamps the change — every consent flip is meant to be auditable
  // (it's the one field in this whole module with real legal/compliance
  // weight, since it gates whether marketing messages can ever be sent).
  setConsentStatus(id: string, status: ConsentStatus): CrmContact {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE crm_contacts SET consent_status = ?, consent_recorded_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, id);
    const contact = this.getContact(id);
    if (!contact) throw new Error(`Contact ${id} not found`);
    return contact;
  }

  listMessagesForContact(contactId: string): CrmMessage[] {
    return this.db
      .prepare(`
        SELECT id, contact_id as contactId, direction, message_type as messageType, template_name as templateName,
               body, status, triggered_by as triggeredBy, wa_message_id as waMessageId, created_at as createdAt
        FROM crm_messages WHERE contact_id = ? ORDER BY created_at ASC`)
      .all(contactId) as CrmMessage[];
  }

  insertMessage(input: {
    contactId: string; direction: MessageDirection; messageType: MessageType;
    templateName?: string | null; body: string; status: MessageStatus; triggeredBy?: string | null; waMessageId?: string | null;
  }): CrmMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO crm_messages (id, contact_id, direction, message_type, template_name, body, status, triggered_by, wa_message_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.contactId, input.direction, input.messageType, input.templateName ?? null, input.body, input.status, input.triggeredBy ?? null, input.waMessageId ?? null, now);
    return { id, contactId: input.contactId, direction: input.direction, messageType: input.messageType, templateName: input.templateName ?? null, body: input.body, status: input.status, triggeredBy: input.triggeredBy ?? null, waMessageId: input.waMessageId ?? null, createdAt: now };
  }

  updateMessageStatus(id: string, status: MessageStatus, waMessageId?: string | null): void {
    if (waMessageId) {
      this.db.prepare("UPDATE crm_messages SET status = ?, wa_message_id = ? WHERE id = ?").run(status, waMessageId, id);
    } else {
      this.db.prepare("UPDATE crm_messages SET status = ? WHERE id = ?").run(status, id);
    }
  }

  // Whether the contact has an inbound message within the last 24h — Meta's
  // own rule for when a freeform reply is allowed at all (outside this
  // window, only an approved template can be sent). Computed here, not
  // re-derived client-side, so the admin UI can't drift from the actual rule.
  isWithinServiceWindow(contactId: string): boolean {
    const row = this.db
      .prepare("SELECT created_at FROM crm_messages WHERE contact_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1")
      .get(contactId) as { created_at: string } | undefined;
    if (!row) return false;
    return Date.now() - new Date(row.created_at).getTime() < 24 * 60 * 60 * 1000;
  }

  getContactDetail(id: string): CrmContactDetail | null {
    const contact = this.getContact(id);
    if (!contact) return null;
    return { contact, messages: this.listMessagesForContact(id), withinServiceWindow: this.isWithinServiceWindow(id) };
  }

  // The one place an outbound WhatsApp send is actually queued — used by
  // both automation (server/whatsapp/automation.ts) and manual staff sends
  // (server/routes/crm.ts), so the outbox row and its crm_messages log
  // entry are always created together, correctly linked (see the
  // crm_message_id column comment above), regardless of which caller.
  enqueueOutboundMessage(input: {
    contactId: string; messageType: MessageType; templateName?: string | null; templateParams?: unknown[];
    freeformBody?: string | null; body: string; triggeredBy: string;
  }): { outboxId: string; message: CrmMessage } {
    const message = this.insertMessage({
      contactId: input.contactId, direction: "outbound", messageType: input.messageType,
      templateName: input.templateName, body: input.body, status: "queued", triggeredBy: input.triggeredBy
    });
    const outboxId = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO whatsapp_outbox (id, contact_id, template_name, template_params, freeform_body, status, attempts, created_at, crm_message_id)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
      .run(outboxId, input.contactId, input.templateName ?? null, input.templateParams ? JSON.stringify(input.templateParams) : null, input.freeformBody ?? null, now, message.id);
    return { outboxId, message };
  }

  listPendingOutbox(): WhatsappOutboxItem[] {
    return this.db
      .prepare(`
        SELECT id, contact_id as contactId, template_name as templateName, template_params as templateParams,
               freeform_body as freeformBody, status, attempts, created_at as createdAt, sent_at as sentAt
        FROM whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as WhatsappOutboxItem[];
  }

  // The worker (server/whatsapp/outboxWorker.ts) calls this after every
  // send attempt. attempts always increments; a failed attempt is left in
  // status='pending' (still returned by listPendingOutbox, so the worker
  // retries it next poll) unless the worker tells us this was the final
  // try (permanent=true, past its retry ceiling), in which case it's
  // marked 'failed' for good — the worker owns the retry ceiling, not
  // this method.
  recordOutboxAttempt(id: string, result: "sent" | "failed", permanent = false): void {
    const now = new Date().toISOString();
    if (result === "sent") {
      this.db.prepare("UPDATE whatsapp_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?").run(now, id);
    } else if (permanent) {
      this.db.prepare("UPDATE whatsapp_outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE whatsapp_outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
    }
  }

  // Only used internally by the worker to find the crm_messages row to
  // update after a send attempt — not part of the public WhatsappOutboxItem
  // shape (crm_message_id is an implementation detail of the link, not
  // something callers outside this file need).
  private getOutboxCrmMessageId(outboxId: string): string | null {
    const row = this.db.prepare("SELECT crm_message_id as crmMessageId FROM whatsapp_outbox WHERE id = ?").get(outboxId) as { crmMessageId: string | null } | undefined;
    return row?.crmMessageId ?? null;
  }

  // Called by the outbox worker after a Meta API call resolves — updates
  // both the outbox row (queue bookkeeping) and the linked crm_messages
  // row (status the admin CRM UI actually displays) together. On a
  // transient failure (permanent=false) the crm_messages row is left as
  // 'queued' — it's still going to be retried, so it shouldn't read as a
  // final failure to admin staff yet.
  resolveOutboxSend(outboxId: string, result: "sent" | "failed", waMessageId?: string | null, permanent = false): void {
    this.recordOutboxAttempt(outboxId, result, permanent);
    if (result === "sent" || permanent) {
      const messageId = this.getOutboxCrmMessageId(outboxId);
      if (messageId) this.updateMessageStatus(messageId, result === "sent" ? "sent" : "failed", waMessageId);
    }
  }

  getAutomationRule(eventName: string): CrmAutomationRule | null {
    return this.db
      .prepare("SELECT id, event_name as eventName, template_name as templateName, enabled FROM crm_automation_rules WHERE event_name = ?")
      .get(eventName) as CrmAutomationRule | null;
  }

  listAutomationRules(): CrmAutomationRule[] {
    return this.db.prepare("SELECT id, event_name as eventName, template_name as templateName, enabled FROM crm_automation_rules ORDER BY event_name").all() as CrmAutomationRule[];
  }

  // Upsert by event_name (it's UNIQUE) — the admin UI manages a fixed small
  // set of events (order_ready, payment_received), not arbitrary ones.
  setAutomationRule(eventName: string, templateName: string, enabled: boolean): CrmAutomationRule {
    const existing = this.getAutomationRule(eventName);
    if (existing) {
      this.db.prepare("UPDATE crm_automation_rules SET template_name = ?, enabled = ? WHERE event_name = ?").run(templateName, enabled ? 1 : 0, eventName);
    } else {
      this.db.prepare("INSERT INTO crm_automation_rules (id, event_name, template_name, enabled) VALUES (?, ?, ?, ?)").run(randomUUID(), eventName, templateName, enabled ? 1 : 0);
    }
    return this.getAutomationRule(eventName)!;
  }

  // ── Email order notifications ────────────────────────────────────────────
  // Independent of the WhatsApp outbox above (see the email_outbox schema
  // comment) — no contact/consent indirection, the outbox row itself is
  // the whole record (no separate message-log table like crm_messages).

  enqueueEmail(orderId: number | null, toEmail: string, subject: string, body: string, htmlBody: string | null = null): EmailOutboxItem {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO email_outbox (id, order_id, to_email, subject, body, html_body, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run(id, orderId, toEmail, subject, body, htmlBody, now);
    return { id, orderId, toEmail, subject, body, htmlBody, status: "pending", attempts: 0, createdAt: now, sentAt: null };
  }

  listPendingEmails(): EmailOutboxItem[] {
    return this.db
      .prepare(`
        SELECT id, order_id as orderId, to_email as toEmail, subject, body, html_body as htmlBody, status, attempts, created_at as createdAt, sent_at as sentAt
        FROM email_outbox WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as EmailOutboxItem[];
  }

  // Same shape as recordOutboxAttempt above: a transient failure
  // (permanent=false) is left in status='pending' so the worker retries it
  // next poll; only a permanent failure (past the retry ceiling, which the
  // worker owns) is marked 'failed' for good.
  recordEmailAttempt(id: string, result: "sent" | "failed", permanent = false): void {
    const now = new Date().toISOString();
    if (result === "sent") {
      this.db.prepare("UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?").run(now, id);
    } else if (permanent) {
      this.db.prepare("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE email_outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
    }
  }

  // ── Email marketing list ─────────────────────────────────────────────────

  // Called once per order that carries a customerEmail (see
  // server/routes/orders.ts) — a no-op re-insert on repeat orders from the
  // same address, except it refreshes the name if the order supplied one
  // and the subscriber didn't previously have one (walk-in orders often
  // capture email without a name on later visits, or vice versa). Never
  // resurrects a subscriber who explicitly unsubscribed.
  upsertEmailSubscriber(email: string, name: string | null, source = "order"): void {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id, name, status FROM email_subscribers WHERE email = ? COLLATE NOCASE").get(trimmedEmail) as { id: string; name: string | null; status: string } | null;
    if (existing) {
      if (!existing.name && name?.trim()) {
        this.db.prepare("UPDATE email_subscribers SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), now, existing.id);
      }
      return;
    }
    this.db
      .prepare("INSERT INTO email_subscribers (id, name, email, status, unsubscribe_token, source, created_at, updated_at) VALUES (?, ?, ?, 'subscribed', ?, ?, ?, ?)")
      .run(randomUUID(), name?.trim() || null, trimmedEmail, randomUUID(), source, now, now);
  }

  listEmailSubscribers(): EmailSubscriber[] {
    return this.db
      .prepare("SELECT id, name, email, status, source, created_at as createdAt, updated_at as updatedAt FROM email_subscribers ORDER BY created_at DESC")
      .all() as EmailSubscriber[];
  }

  // Unlike upsertEmailSubscriber (auto-capture from orders, which never
  // resurrects an unsubscribe), an admin manually adding an address here is
  // an explicit action — re-subscribes it if it previously opted out.
  addEmailSubscriber(email: string, name: string | null): EmailSubscriber {
    const trimmedEmail = email.trim();
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM email_subscribers WHERE email = ? COLLATE NOCASE").get(trimmedEmail) as { id: string } | null;
    if (existing) {
      this.db.prepare("UPDATE email_subscribers SET status = 'subscribed', name = COALESCE(NULLIF(?, ''), name), updated_at = ? WHERE id = ?").run(name?.trim() || "", now, existing.id);
    } else {
      this.db
        .prepare("INSERT INTO email_subscribers (id, name, email, status, unsubscribe_token, source, created_at, updated_at) VALUES (?, ?, ?, 'subscribed', ?, 'manual', ?, ?)")
        .run(randomUUID(), name?.trim() || null, trimmedEmail, randomUUID(), now, now);
    }
    return this.db.prepare("SELECT id, name, email, status, source, created_at as createdAt, updated_at as updatedAt FROM email_subscribers WHERE email = ? COLLATE NOCASE").get(trimmedEmail) as EmailSubscriber;
  }

  setEmailSubscriberStatus(id: string, status: "subscribed" | "unsubscribed"): EmailSubscriber {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE email_subscribers SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    const row = this.db.prepare("SELECT id, name, email, status, source, created_at as createdAt, updated_at as updatedAt FROM email_subscribers WHERE id = ?").get(id) as EmailSubscriber | undefined;
    if (!row) throw new Error("Subscriber not found");
    return row;
  }

  // Token lookup for the public, no-auth unsubscribe link embedded in
  // campaign emails — deliberately not the subscriber's id (would let
  // anyone unsubscribe anyone by guessing/incrementing ids).
  unsubscribeByToken(token: string): boolean {
    const row = this.db.prepare("SELECT id FROM email_subscribers WHERE unsubscribe_token = ?").get(token) as { id: string } | null;
    if (!row) return false;
    this.db.prepare("UPDATE email_subscribers SET status = 'unsubscribed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return true;
  }

  getEmailSubscriberToken(id: string): string | null {
    const row = this.db.prepare("SELECT unsubscribe_token as token FROM email_subscribers WHERE id = ?").get(id) as { token: string } | null;
    return row?.token ?? null;
  }

  deleteEmailSubscriber(id: string): void {
    this.db.prepare("DELETE FROM email_subscribers WHERE id = ?").run(id);
  }

  // Every currently-subscribed address, for the "send campaign" broadcast —
  // queues one email_outbox row per recipient (order_id null, this isn't
  // tied to any single order) with the unsubscribe link already baked into
  // htmlBody by the caller (server/email/campaign.ts), same fire-and-forget
  // posture as order-notification emails: the worker owns retries.
  listSubscribedEmails(): EmailSubscriber[] {
    return this.db
      .prepare("SELECT id, name, email, status, source, created_at as createdAt, updated_at as updatedAt FROM email_subscribers WHERE status = 'subscribed'")
      .all() as EmailSubscriber[];
  }

  // ── Order-notification message templates ─────────────────────────────────
  // See the order_message_templates schema comment (migrate()) for what
  // these are and their Meta-window constraint.

  getOrderMessageTemplate(fulfillmentType: "pickup" | "delivery", paymentStatus: "paid" | "unpaid"): OrderMessageTemplate | null {
    const row = this.db
      .prepare("SELECT id, fulfillment_type as fulfillmentType, payment_status as paymentStatus, body, updated_at as updatedAt FROM order_message_templates WHERE fulfillment_type = ? AND payment_status = ?")
      .get(fulfillmentType, paymentStatus) as OrderMessageTemplate | undefined;
    return row ?? null;
  }

  listOrderMessageTemplates(): OrderMessageTemplate[] {
    return this.db
      .prepare("SELECT id, fulfillment_type as fulfillmentType, payment_status as paymentStatus, body, updated_at as updatedAt FROM order_message_templates ORDER BY fulfillment_type, payment_status")
      .all() as OrderMessageTemplate[];
  }

  setOrderMessageTemplate(id: string, body: string): OrderMessageTemplate {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE order_message_templates SET body = ?, updated_at = ? WHERE id = ?").run(body, now, id);
    const row = this.getOrderMessageTemplateById(id);
    if (!row) throw new Error(`Unknown order message template id "${id}"`);
    return row;
  }

  private getOrderMessageTemplateById(id: string): OrderMessageTemplate | null {
    const row = this.db
      .prepare("SELECT id, fulfillment_type as fulfillmentType, payment_status as paymentStatus, body, updated_at as updatedAt FROM order_message_templates WHERE id = ?")
      .get(id) as OrderMessageTemplate | undefined;
    return row ?? null;
  }

  // ── Label format presets ──────────────────────────────────────────────────
  // See the label_formats schema comment (migrate()) for what these are.
  listLabelFormats(): LabelFormat[] {
    return this.db
      .prepare("SELECT id, name, type, brand, code, widthMm, heightMm, sheetCols, sheetRows, marginTopMm, marginLeftMm, gapXMm, gapYMm, pageWidthMm, pageHeightMm FROM label_formats ORDER BY sortOrder ASC")
      .all() as LabelFormat[];
  }

  private getLabelFormat(id: string): LabelFormat {
    const row = this.db
      .prepare("SELECT id, name, type, brand, code, widthMm, heightMm, sheetCols, sheetRows, marginTopMm, marginLeftMm, gapXMm, gapYMm, pageWidthMm, pageHeightMm FROM label_formats WHERE id = ?")
      .get(id) as LabelFormat | undefined;
    if (!row) throw new Error(`Label format "${id}" not found`);
    return row;
  }

  // Lets an admin add a sheet that isn't one of the bundled Tower/Avery
  // presets — any brand/code they physically have, so a format this app
  // doesn't already know about still works rather than being a dead end.
  // Ids are prefixed "custom_" (vs. the bundled presets' "thermal_"/
  // "a4_"/"tw_"/"av_" prefixes) purely so the client can tell which rows
  // it's safe to offer editing/deleting for — never touches a bundled
  // preset's row. Appended after every existing format (sortOrder =
  // current max + 1) so custom formats show up after the presets, not
  // interleaved with them.
  createLabelFormat(input: LabelFormatInput): LabelFormat {
    const brand = input.brand.trim();
    const code = input.code.trim();
    if (!brand) throw new Error("Brand is required");
    if (!code) throw new Error("Product code is required");
    if (!(input.widthMm > 0) || !(input.heightMm > 0)) throw new Error("Label width and height must be greater than 0");
    if (input.type === "a4_sheet" && (!input.sheetCols || !input.sheetRows)) {
      throw new Error("Columns and rows are required for a sheet format");
    }
    const id = `custom_${randomUUID().slice(0, 8)}`;
    const name = input.type === "a4_sheet" && input.sheetCols && input.sheetRows
      ? `${brand} ${code} - ${input.sheetCols * input.sheetRows}/sheet`
      : `${brand} ${code}`;
    const { sort } = this.db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 as sort FROM label_formats").get() as { sort: number };
    this.db
      .prepare("INSERT INTO label_formats (id, name, type, brand, code, widthMm, heightMm, sheetCols, sheetRows, marginTopMm, marginLeftMm, gapXMm, gapYMm, pageWidthMm, pageHeightMm, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, input.type, brand, code, input.widthMm, input.heightMm, input.sheetCols, input.sheetRows, input.marginTopMm, input.marginLeftMm, input.gapXMm, input.gapYMm, input.pageWidthMm, input.pageHeightMm, sort, new Date().toISOString());
    return this.getLabelFormat(id);
  }

  // Only for "custom_"-prefixed (i.e. not a bundled preset) rows — see
  // createLabelFormat's comment. Re-derives the display name from the
  // (possibly changed) brand/code/count, same as creation.
  updateLabelFormat(id: string, input: LabelFormatInput): LabelFormat {
    if (!id.startsWith("custom_")) throw new Error("Only a custom format can be edited");
    const brand = input.brand.trim();
    const code = input.code.trim();
    if (!brand) throw new Error("Brand is required");
    if (!code) throw new Error("Product code is required");
    if (!(input.widthMm > 0) || !(input.heightMm > 0)) throw new Error("Label width and height must be greater than 0");
    if (input.type === "a4_sheet" && (!input.sheetCols || !input.sheetRows)) {
      throw new Error("Columns and rows are required for a sheet format");
    }
    const name = input.type === "a4_sheet" && input.sheetCols && input.sheetRows
      ? `${brand} ${code} - ${input.sheetCols * input.sheetRows}/sheet`
      : `${brand} ${code}`;
    const result = this.db
      .prepare("UPDATE label_formats SET name=?, type=?, brand=?, code=?, widthMm=?, heightMm=?, sheetCols=?, sheetRows=?, marginTopMm=?, marginLeftMm=?, gapXMm=?, gapYMm=?, pageWidthMm=?, pageHeightMm=? WHERE id=?")
      .run(name, input.type, brand, code, input.widthMm, input.heightMm, input.sheetCols, input.sheetRows, input.marginTopMm, input.marginLeftMm, input.gapXMm, input.gapYMm, input.pageWidthMm, input.pageHeightMm, id);
    if (result.changes === 0) throw new Error(`Label format "${id}" not found`);
    return this.getLabelFormat(id);
  }

  deleteLabelFormat(id: string): void {
    if (!id.startsWith("custom_")) throw new Error("Only a custom format can be deleted");
    this.db.prepare("DELETE FROM label_formats WHERE id = ?").run(id);
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
