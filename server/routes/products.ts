// Product catalog CRUD, plus bulk CSV import/export for the admin menu editor.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { ProductInput, QuickCreateProductInput } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth);

// Roles that build orders/receipts and so are allowed to add a new item
// on the spot via an unrecognized barcode scan (see quick-create below) —
// deliberately narrower than full admin product management.
const canQuickCreate = (req: AuthRequest) =>
  req.user?.role === "admin" || req.user?.role === "cashier" || req.user?.role === "master_cashier";

router.get("/", (_req, res) => { res.json(db.listProducts()); });

// Barcode lookup for the "scan to add to order" flow. Any authenticated
// user can look up (read-only, same posture as GET / above).
router.get("/barcode/:code", (req, res) => {
  const product = db.getProductByBarcode(req.params.code);
  if (!product) { res.status(404).json({ message: "No product found for this barcode" }); return; }
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

// Only admins may create, update, or delete products
router.post("/", requireAdmin, (req, res) => {
  try { res.status(201).json(db.upsertProduct(req.body as ProductInput)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to save product" }); }
});

router.put("/:id", requireAdmin, (req, res) => {
  try { res.json(db.upsertProduct({ ...req.body, id: Number(req.params.id) } as ProductInput)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update product" }); }
});

router.delete("/:id", requireAdmin, (req, res) => {
  try { db.deleteProduct(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to delete product" }); }
});

// Bulk-creates/updates products from a CSV upload. Column order is
// flexible — matched by header name (case-insensitive, punctuation-stripped)
// rather than position, and a few columns accept common alias names
// (e.g. "price" or "priceperunit").
router.post("/import", requireAdmin, (req, res) => {
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
        pricePerUnit: col(r, "pricerperunit") || col(r, "priceperunit") || col(r, "price"),
        prepNotes: col(r, "prepnotes") || col(r, "notes"),
        department: col(r, "department") || col(r, "dept"),
      };
    });

    res.json(db.importProducts(rows));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Import failed" });
  }
});

router.get("/export", requireAdmin, (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="maxis-products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(db.exportProducts());
});

export default router;
