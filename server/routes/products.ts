// Product catalog CRUD, plus bulk CSV import/export for the admin menu editor.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { ProductInput, QuickCreateProductInput, YieldEstimateInput } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth);

// Roles that build orders/receipts and so are allowed to add a new item
// on the spot via an unrecognized barcode scan (see quick-create below) —
// deliberately narrower than full admin product management.
const canQuickCreate = (req: AuthRequest) =>
  req.user?.role === "admin" || req.user?.role === "cashier" || req.user?.role === "master_cashier";

router.get("/", (_req, res) => { res.json(db.listProducts()); });

// POS "quick picks" row — any authenticated till role (not admin-only),
// since this is read at checkout time by cashiers, not just configured
// by admins. See getQuickPickProducts for the pinned-vs-auto logic.
router.get("/quick-picks", (_req, res) => { res.json(db.getQuickPickProducts()); });

// Admin dashboard widget: active products with no cost price ever
// recorded (see listProductsMissingCost) — deliberately never auto-filled
// with 0, so these need someone to actually enter a real number.
router.get("/missing-cost", requireAdmin, (_req, res) => { res.json(db.listProductsMissingCost()); });

// On-demand version of the reconciliation pass that otherwise only runs
// at server startup and after a CSV import (see
// db.reconcileMissingCodes) — lets an admin fix any product still
// missing a barcode/item code right now, from the running app, without
// needing to restart the service. Wired to the Stock tab's Refresh
// button on the client.
router.post("/reconcile-codes", requireAdmin, (_req, res) => {
  const barcodeIds = db.reconcileMissingBarcodes();
  const itemCodeIds = db.reconcileMissingItemCodes();
  res.json({ barcodeIds, itemCodeIds });
});

// Barcode lookup for the "scan to add to order" flow. Any authenticated
// user can look up (read-only, same posture as GET / above).
router.get("/barcode/:code", (req, res) => {
  const product = db.getProductByBarcode(req.params.code);
  if (!product) { res.status(404).json({ message: "No product found for this barcode" }); return; }
  res.json(product);
});

// Item-code lookup — the weighed-product counterpart to /barcode/:code
// above. Callers decode a scanned weigh-barcode with parseWeighBarcode
// first (see src/shared/weighBarcode.ts) and look the product up by the
// resulting itemCode here, never by the raw scanned string (which is
// unique per label, not per product).
router.get("/item-code/:code", (req, res) => {
  const product = db.getProductByItemCode(req.params.code);
  if (!product) { res.status(404).json({ message: "No product found for this item code" }); return; }
  res.json(product);
});

// Minimal product creation from an unrecognized barcode scan — see
// db.quickCreateProductByBarcode for the field defaults this applies.
router.post("/quick-create", (req: AuthRequest, res) => {
  if (!canQuickCreate(req)) {
    res.status(403).json({ message: "Not authorized to add products" });
    return;
  }
  try {
    res.status(201).json(db.quickCreateProductByBarcode(req.body as QuickCreateProductInput));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to create product" });
  }
});

// Only inserts a new product_cost_history row when the cost actually
// changed — the edit form resubmits editing.costPerUnit on every save
// (even one only touching an unrelated field, or the barcode-regenerate
// action), and cost_history is meant to track real changes over time, not
// grow a duplicate row every time someone saves the form unchanged.
function maybeUpdateCost(productId: number, costPerUnit: number | null | undefined, createdById: number): void {
  if (costPerUnit == null) return;
  if (db.getCurrentCost(productId) === costPerUnit) return;
  db.setProductCost(productId, costPerUnit, createdById);
}

// Only admins may create, update, or delete products
router.post("/", requireAdmin, (req: AuthRequest, res) => {
  try {
    const input = req.body as ProductInput;
    const product = db.upsertProduct(input);
    maybeUpdateCost(product.id, input.costPerUnit, req.user!.id);
    res.status(201).json(input.costPerUnit != null ? { ...product, currentCost: input.costPerUnit } : product);
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to save product" }); }
});

router.put("/:id", requireAdmin, (req: AuthRequest, res) => {
  try {
    const input = { ...req.body, id: Number(req.params.id) } as ProductInput;
    const product = db.upsertProduct(input);
    maybeUpdateCost(product.id, input.costPerUnit, req.user!.id);
    res.json(input.costPerUnit != null ? { ...product, currentCost: input.costPerUnit } : product);
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update product" }); }
});

router.delete("/:id", requireAdmin, (req, res) => {
  try { db.deleteProduct(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to delete product" }); }
});

// Cut-yield estimates: what % of a raw-intake product's received weight
// typically becomes each cut/sub-product — configured per raw product,
// consumed automatically by Weigh-In (see db.addWeighInLine) to queue a
// pending conversion, never applied to stock directly from here.
router.get("/:id/yield-estimates", requireAdmin, (req, res) => {
  res.json(db.listYieldEstimates(Number(req.params.id)));
});

router.put("/:id/yield-estimates", requireAdmin, (req, res) => {
  try {
    const estimates = req.body as YieldEstimateInput[];
    res.json(db.setYieldEstimates(Number(req.params.id), estimates));
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to save yield estimates" }); }
});

// Bulk-creates/updates products from a CSV upload. Column order is
// flexible - matched by header name (case-insensitive, punctuation-stripped)
// rather than position, and a few columns accept common alias names
// (sell price: "price", "pricePerUnit", "sellPrice", "sellingPrice",
// "unitPrice", "retailPrice"; cost: "cost", "costPerUnit", "costPrice" -
// applied via the same dedup-by-value guard as the manual edit form, see
// importProducts).
router.post("/import", requireAdmin, (req: AuthRequest, res) => {
  try {
    const { csv } = req.body as { csv: string };
    if (!csv) { res.status(400).json({ message: "No CSV data provided" }); return; }
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) { res.status(400).json({ message: "CSV must have a header row and at least one data row" }); return; }

    // Minimal CSV row parser: splits on commas outside of double-quoted
    // spans. Good enough for the simple exports this import is meant to
    // round-trip with; not a full RFC 4180 implementation (no escaped
    // quotes within a quoted field).
    const parseRow = (line: string): string[] => {
      const cols: string[] = [];
      let cur = "", inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === "," && !inQuote) { cols.push(cur); cur = ""; }
        else { cur += ch; }
      }
      cols.push(cur);
      return cols.map((c) => c.trim());
    };

    const headers = parseRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
    const nameIdx = headers.indexOf("name");
    if (nameIdx === -1) { res.status(400).json({ message: "CSV must have a 'name' column" }); return; }
    const col = (row: string[], key: string) => row[headers.indexOf(key)] ?? "";

    const rows = lines.slice(1).map((line) => {
      const r = parseRow(line);
      return {
        name: col(r, "name"),
        category: col(r, "category"),
        unitDefault: col(r, "unitdefault") || col(r, "unit"),
        pricePerUnit: col(r, "priceperunit") || col(r, "price") || col(r, "sellprice") || col(r, "sellingprice") || col(r, "unitprice") || col(r, "retailprice"),
        prepNotes: col(r, "prepnotes") || col(r, "notes"),
        department: col(r, "department") || col(r, "dept"),
        costPerUnit: col(r, "costperunit") || col(r, "cost") || col(r, "costprice"),
      };
    });

    res.json(db.importProducts(rows, req.user!.id));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Import failed" });
  }
});

router.get("/export", requireAdmin, (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="nemenchpos-products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(db.exportProducts());
});

export default router;
