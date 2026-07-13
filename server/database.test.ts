import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { isValidEan13 } from "../src/shared/ean13";
import { parseWeighBarcode, buildWeighBarcode } from "../src/shared/weighBarcode";
import { KotDatabase } from "./database";

describe("reconcileMissingBarcodes", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemenchpos-test-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("fills in a valid EAN-13 for every qty product missing one, leaves existing barcodes and weighed products untouched", () => {
    const db = new KotDatabase();
    db.initialize();
    // Simulate the exact gap this exists to catch: rows written directly
    // to the table (as CSV import does, and as any pre-migration database
    // would have) rather than through upsertProduct, which already
    // auto-generates a barcode on its own and so can't reproduce the bug.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (db as any).db as BetterSqlite3.Database;
    const now = new Date().toISOString();
    const insert = raw.prepare(
      "INSERT INTO products (name, category, unitDefault, department, barcode, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 'counter', ?, 1, ?, ?)"
    );
    const missingId = Number(insert.run("Boerewors", "Beef", "qty", null, now, now).lastInsertRowid);
    const existingId = Number(insert.run("Lamb Chops", "Lamb", "qty", "2900099000006", now, now).lastInsertRowid);
    const weighedId = Number(insert.run("Beef Mince", "Beef", "kg", null, now, now).lastInsertRowid);

    const fixedIds = db.reconcileMissingBarcodes();

    expect(fixedIds).toEqual([missingId]);

    const rows = raw.prepare("SELECT id, barcode FROM products WHERE id IN (?, ?, ?)").all(missingId, existingId, weighedId) as { id: number; barcode: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.barcode]));

    expect(byId.get(missingId)).toMatch(/^\d{13}$/);
    expect(isValidEan13(byId.get(missingId)!)).toBe(true);
    // Never overwrites a barcode that was already there.
    expect(byId.get(existingId)).toBe("2900099000006");
    // Weighed products deliberately never get a static barcode.
    expect(byId.get(weighedId)).toBeNull();
  });

  it("is a no-op (and returns no ids) when every qty product already has a barcode", () => {
    const db = new KotDatabase();
    db.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (db as any).db as BetterSqlite3.Database;
    const now = new Date().toISOString();
    raw.prepare("INSERT INTO products (name, category, unitDefault, department, barcode, isActive, createdAt, updatedAt) VALUES (?, ?, 'qty', 'counter', ?, 1, ?, ?)")
      .run("Boerewors", "Beef", "2900001000005", now, now);

    expect(db.reconcileMissingBarcodes()).toEqual([]);
  });
});

describe("reconcileMissingItemCodes", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemenchpos-test-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("fills in a 5-digit item code for every weighed product missing one, leaves existing item codes and qty products untouched", () => {
    const db = new KotDatabase();
    db.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (db as any).db as BetterSqlite3.Database;
    const now = new Date().toISOString();
    const insert = raw.prepare(
      "INSERT INTO products (name, category, unitDefault, department, itemCode, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 'counter', ?, 1, ?, ?)"
    );
    const missingId = Number(insert.run("Baguette", "Bakery", "kg", null, now, now).lastInsertRowid);
    const existingId = Number(insert.run("Brown Bread Loaf", "Bakery", "kg", "00777", now, now).lastInsertRowid);
    const qtyId = Number(insert.run("Ciabatta Rolls (4pk)", "Bakery", "qty", null, now, now).lastInsertRowid);

    const fixedIds = db.reconcileMissingItemCodes();

    expect(fixedIds).toEqual([missingId]);

    const rows = raw.prepare("SELECT id, itemCode FROM products WHERE id IN (?, ?, ?)").all(missingId, existingId, qtyId) as { id: number; itemCode: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.itemCode]));

    expect(byId.get(missingId)).toMatch(/^\d{5}$/);
    // Never overwrites an item code that was already there.
    expect(byId.get(existingId)).toBe("00777");
    // qty products deliberately never get an item code — they use barcode.
    expect(byId.get(qtyId)).toBeNull();
  });
});

describe("reconcileMissingCodes", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemenchpos-test-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("leaves no active product without SOME code, regardless of type", () => {
    const db = new KotDatabase();
    db.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (db as any).db as BetterSqlite3.Database;
    const now = new Date().toISOString();
    const insert = raw.prepare(
      "INSERT INTO products (name, category, unitDefault, department, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 'counter', 1, ?, ?)"
    );
    insert.run("Baguette", "Bakery", "kg", now, now);
    insert.run("Ciabatta Rolls (4pk)", "Bakery", "qty", now, now);

    db.reconcileMissingCodes();

    const withoutCode = raw.prepare(`
      SELECT id, name, unitDefault, barcode, itemCode FROM products
      WHERE isActive = 1
        AND ((unitDefault = 'qty' AND (barcode IS NULL OR barcode = ''))
          OR (unitDefault != 'qty' AND (itemCode IS NULL OR itemCode = '')))
    `).all();

    expect(withoutCode).toEqual([]);
  });
});

// Exercises the exact lookup path the POS screen's barcode-scan handler
// calls into (see handleScan in src/ui/App.tsx: parseWeighBarcode then
// getProductByItemCode for a variable-weight scan, getProductByBarcode
// otherwise) — no separate/duplicated lookup logic for scanning vs any
// other barcode entry point in the app.
describe("POS barcode scan lookup", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemenchpos-test-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("finds the right product for a plain fixed-unit barcode scan", () => {
    const db = new KotDatabase();
    db.initialize();
    const product = db.upsertProduct({
      name: "Boerewors", category: "Beef", unitDefault: "qty", pricePerUnit: 89.99,
      prepNotes: "", department: "counter", lowStockThreshold: null, isRawIntake: 0
    });
    expect(product.barcode).not.toBeNull();

    const found = db.getProductByBarcode(product.barcode!);
    expect(found?.id).toBe(product.id);
    expect(found?.name).toBe("Boerewors");
  });

  it("decodes a variable-weight scan and finds the product by its item code, not the raw scanned string", () => {
    const db = new KotDatabase();
    db.initialize();
    const product = db.upsertProduct({
      name: "Sweet Chilli Sticks", category: "Deli", unitDefault: "kg", itemCode: "00550", pricePerUnit: 720,
      prepNotes: "", department: "counter", lowStockThreshold: null, isRawIntake: 0
    });

    const scannedCode = buildWeighBarcode("00550", 99.36); // 0.138kg @ R720/kg
    const decoded = parseWeighBarcode(scannedCode);
    expect(decoded).not.toBeNull();
    expect(decoded!.price).toBe(99.36);

    // A weigh-barcode never exact-matches a plain barcode lookup — it
    // must go through the decoded itemCode instead.
    expect(db.getProductByBarcode(scannedCode)).toBeFalsy();
    const found = db.getProductByItemCode(decoded!.itemCode);
    expect(found?.id).toBe(product.id);
  });

  it("returns a falsy result (not found) for a barcode that matches no product", () => {
    const db = new KotDatabase();
    db.initialize();
    // better-sqlite3's .get() actually returns undefined for no match at
    // runtime (despite these methods being typed as Product | null) — the
    // POS scan handler treats either the same way (a thrown/failed
    // lookup shows the inline "not found" message), so this checks
    // falsy rather than assuming which one.
    expect(db.getProductByBarcode("2999999000004")).toBeFalsy();
    expect(db.getProductByItemCode("99999")).toBeFalsy();
  });
});
