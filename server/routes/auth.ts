import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../index.js";
import { signToken, requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";

const router = Router();

router.post("/login", (req, res) => {
  const { name, pin } = req.body as { name: string; pin: string };
  if (!name || !pin) { res.status(400).json({ message: "Name and PIN required" }); return; }
  const user = db.getUserByName(name);
  if (!user || !bcrypt.compareSync(String(pin), user.pin)) {
    res.status(401).json({ message: "Invalid name or PIN" });
    return;
  }
  const { pin: _pin, ...safeUser } = user;
  res.json({ token: signToken(safeUser), user: safeUser });
});

router.get("/me", requireAuth, (req: AuthRequest, res) => {
  res.json(req.user);
});

export default router;
