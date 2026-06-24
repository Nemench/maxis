import { Router } from "express";
import { db } from "../index.js";
import { requireAuth } from "../auth.js";
import type { ProductInput } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth);

router.get("/", (_req, res) => { res.json(db.listProducts()); });

router.post("/", (req, res) => {
  try { res.status(201).json(db.upsertProduct(req.body as ProductInput)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to save product" }); }
});

router.put("/:id", (req, res) => {
  try { res.json(db.upsertProduct({ ...req.body, id: Number(req.params.id) } as ProductInput)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update product" }); }
});

router.delete("/:id", (req, res) => {
  try { db.deleteProduct(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : "Failed to delete product" }); }
});

export default router;
