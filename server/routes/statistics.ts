// Admin-only Statistics screen: per-item sales performance and stock
// movement (received vs. current on-hand) within a date range.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(req: import("express").Request): [string, string] | null {
  const from = req.query.from as string;
  const to = req.query.to as string;
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) return null;
  return [from, to];
}

// GET /api/statistics/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/sales", (req, res) => {
  const range = parseRange(req);
  if (!range) { res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return; }
  res.json(db.salesByItem(...range));
});

// GET /api/statistics/stock-movement?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/stock-movement", (req, res) => {
  const range = parseRange(req);
  if (!range) { res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return; }
  res.json(db.stockMovementByItem(...range));
});

// GET /api/statistics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/overview", (req, res) => {
  const range = parseRange(req);
  if (!range) { res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return; }
  res.json(db.statisticsOverview(...range));
});

// GET /api/statistics/margins?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=product|category|day
router.get("/margins", (req, res) => {
  const range = parseRange(req);
  if (!range) { res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return; }
  const groupByRaw = req.query.group_by as string;
  if (groupByRaw !== "product" && groupByRaw !== "category" && groupByRaw !== "day") {
    res.status(400).json({ message: "group_by must be one of: product, category, day" });
    return;
  }
  res.json(db.getMarginOverview(...range, groupByRaw));
});

export default router;
