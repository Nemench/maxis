// Order Consolidation: a final packing/QA step where staff scan every
// line item's barcode to verify it against a "Ready" order, then get one
// consolidation barcode + receipt for the whole order. See
// server/database.ts's Order Consolidation section for the actual logic —
// this router is just auth/role gating plus thin request/response glue.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";

const router = Router();
router.use(requireAuth);

// Matches the roles named in the feature spec exactly (kitchen, counter,
// cashier, admin) — deliberately not master_cashier/stock_taker, which
// weren't asked for; easy to extend later if that's wrong.
const canConsolidate = (req: AuthRequest) => {
  const role = req.user?.role;
  return role === "kitchen" || role === "counter" || role === "cashier" || role === "admin";
};

router.use((req: AuthRequest, res, next) => {
  if (!canConsolidate(req)) { res.status(403).json({ message: "Not authorized to consolidate orders" }); return; }
  next();
});

router.get("/pending", (_req, res) => {
  res.json(db.listOrdersPendingConsolidation());
});

// Returns the full order (not just the matched item) — the client's
// checklist needs every line's up-to-date scannedAt to redraw progress,
// not just the one that changed.
router.post("/:id/scan", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ message: "Not found" }); return; }
  const { code } = req.body as { code?: string };
  if (!code?.trim()) { res.status(400).json({ message: "No barcode provided" }); return; }
  try {
    db.scanConsolidationItem(id, code.trim());
    res.json(db.getOrder(id));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Scan failed" });
  }
});

router.post("/:id/finalize", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ message: "Not found" }); return; }
  try {
    res.json(db.finalizeConsolidation(id));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Could not finalize consolidation" });
  }
});

export default router;
