import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { UserInput } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/", (_req, res) => { res.json(db.listUsers()); });

router.post("/", (req: AuthRequest, res) => {
  try {
    res.status(201).json(db.createUser(req.body as UserInput));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to create user" });
  }
});

router.patch("/:id", (req: AuthRequest, res) => {
  try {
    res.json(db.updateUser(Number(req.params.id), req.body));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update user" });
  }
});

export default router;
