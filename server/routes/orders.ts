import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { CreateOrderInput, OrderStatus, Department, DeptStatus } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth);

// Export orders by date range — must be before /:id to avoid "export" being matched as an ID
router.get("/export", requireAdmin, (req, res) => {
  const from = req.query.from as string;
  const to = req.query.to as string;
  if (!from || !to) { res.status(400).json({ message: "from and to are required (YYYY-MM-DD)" }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ message: "Date must be in YYYY-MM-DD format" }); return;
  }
  if (from > to) { res.status(400).json({ message: "'from' must not be after 'to'" }); return; }
  res.json(db.listOrdersInRange(from, to));
});

router.get("/", (req: AuthRequest, res) => {
  const scope = (req.query.scope as string) || "active";
  const role = req.user?.role;
  const dept: Department | null =
    role === "kitchen" ? "kitchen" :
    role === "counter" ? "counter" :
    null;
  res.json(db.listOrders(scope as "active" | "history" | "all", dept));
});

router.post("/", (req: AuthRequest, res) => {
  try { res.status(201).json(db.createOrder(req.body as CreateOrderInput, req.user!.id)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to create order" }); }
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ message: "Not found" }); return; }
  try { res.json(db.getOrder(id)); }
  catch (err) { res.status(404).json({ message: err instanceof Error ? err.message : "Not found" }); }
});

router.patch("/:id/status", (req, res) => {
  try { res.json(db.updateOrderStatus(Number(req.params.id), req.body.status as OrderStatus)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update status" }); }
});

router.patch("/:id/dept-status", (req: AuthRequest, res) => {
  try {
    const { department, status } = req.body as { department: Department; status: DeptStatus };
    const role = req.user?.role;
    // Kitchen staff can only update kitchen; counter staff can only update counter
    if (role === "kitchen" && department !== "kitchen") {
      res.status(403).json({ message: "Kitchen staff can only update kitchen status" });
      return;
    }
    if (role === "counter" && department !== "counter") {
      res.status(403).json({ message: "Counter staff can only update counter status" });
      return;
    }
    res.json(db.updateDeptStatus(Number(req.params.id), department, status));
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update status" }); }
});

export default router;
