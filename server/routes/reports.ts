import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";

const router = Router();

router.get("/", requireAuth, requireAdmin, (req, res) => {
  const from = req.query.from as string;
  const to = req.query.to as string;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return;
  }
  res.json(db.listOrdersInRange(from, to));
});

export default router;
