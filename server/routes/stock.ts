// Stock-take screen: viewing on-hand quantities and recording physical
// counts per location. (Automatic stock adjustments from weigh-ins go
// through weighIn.ts instead — see db.adjustProductStock.)
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";

const router = Router();
router.use(requireAuth);

const canCount = (req: AuthRequest) => req.user?.role === "admin" || req.user?.role === "stock_taker";

router.get("/", (_req, res) => { res.json(db.listProducts()); });

// Products at or below their configured lowStockThreshold (compared against
// the total across all locations) — drives the low-stock warning badge.
router.get("/low", (_req, res) => { res.json(db.listLowStock()); });

// Every active product's quantity at one location — what the Stock Take
// screen actually displays and counts against.
router.get("/location/:locationId", (req, res) => {
  res.json(db.listProductStockForLocation(Number(req.params.locationId)));
});

// Records a physical count at a location. There is deliberately no "just
// set it to X" endpoint for anyone, admin included — every change to a
// location's quantity is computed from what was actually counted (see
// db.recordStockCount), so there's no path to blindly overwrite the total.
router.put("/:id", (req: AuthRequest, res) => {
  if (!canCount(req)) {
    res.status(403).json({ message: "Not authorized to update stock" });
    return;
  }
  const { locationId, countedQty } = req.body as { locationId: number; countedQty: number };
  if (!locationId) { res.status(400).json({ message: "locationId is required" }); return; }
  if (typeof countedQty !== "number" || countedQty < 0) {
    res.status(400).json({ message: "countedQty must be a non-negative number" });
    return;
  }
  try {
    res.json(db.recordStockCount(Number(req.params.id), locationId, countedQty, req.user!.id));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update stock" });
  }
});

// ── Stock locations ──────────────────────────────────────────────────────────

router.get("/locations", (_req, res) => { res.json(db.listStockLocations()); });

router.post("/locations", requireAdmin, (req, res) => {
  try { res.status(201).json(db.createStockLocation((req.body as { name: string }).name)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to add location" }); }
});

router.delete("/locations/:id", requireAdmin, (req, res) => {
  db.deactivateStockLocation(Number(req.params.id));
  res.json({ success: true });
});

export default router;
