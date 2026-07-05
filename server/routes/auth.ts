// Login (name + PIN, not a password) and "who am I" endpoints.
import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../index.js";
import { signToken, requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";

const router = Router();

// Per-IP brute-force guard: max 10 failed PIN attempts per 15 minutes.
// In-memory only (resets on server restart) — acceptable for a single-shop
// kiosk deployment where a restart already interrupts everyone's session.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

router.post("/login", (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();

  const rec = loginAttempts.get(ip);
  if (rec && now < rec.resetAt && rec.count >= 10) {
    res.status(429).json({ message: "Too many failed login attempts. Please wait 15 minutes." });
    return;
  }

  const { name, pin } = req.body as { name: string; pin: string };
  if (!name || !pin) { res.status(400).json({ message: "Name and PIN required" }); return; }

  const user = db.getUserByName(name);
  if (!user || !bcrypt.compareSync(String(pin), user.pin)) {
    const existing = loginAttempts.get(ip);
    if (existing && now < existing.resetAt) {
      existing.count++;
    } else {
      loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    }
    res.status(401).json({ message: "Invalid name or PIN" });
    return;
  }

  // Clear rate limit counter on successful login
  loginAttempts.delete(ip);

  // Never send the hashed PIN back to the client.
  const { pin: _pin, ...safeUser } = user;
  res.json({ token: signToken(safeUser), user: safeUser });
});

// Re-confirms the logged-in user's own PIN before a mistake-prone action
// (e.g. removing a line from a POS sale) — a "yes, this was really you"
// gate, not a fresh login: no new token, no session change. Shares the
// login route's per-IP brute-force guard, since it's the same PIN-guessing
// attack surface on a shared terminal.
router.post("/verify-pin", requireAuth, (req: AuthRequest, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();

  const rec = loginAttempts.get(ip);
  if (rec && now < rec.resetAt && rec.count >= 10) {
    res.status(429).json({ message: "Too many failed attempts. Please wait 15 minutes." });
    return;
  }

  const { pin } = req.body as { pin: string };
  if (!pin || !db.verifyUserPin(req.user!.id, pin)) {
    const existing = loginAttempts.get(ip);
    if (existing && now < existing.resetAt) existing.count++;
    else loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    // 403, not 401 — the client's req() helper treats any 401 as "session
    // expired" and force-logs-out on the spot, which a wrong PIN here
    // definitely isn't (the session/token are still perfectly valid).
    res.status(403).json({ message: "Incorrect PIN" });
    return;
  }

  loginAttempts.delete(ip);
  res.json({ ok: true });
});

// Used on app boot to validate a stored token and refresh user info
// (e.g. role changes made by an admin take effect without re-login).
router.get("/me", requireAuth, (req: AuthRequest, res) => {
  if (req.user?.id) db.touchLastSeen(req.user.id);
  res.json(req.user);
});

// Lets the logged-in user set their own light/dark preference — saved to
// their account (not the device) so it follows them to any terminal they
// log into. Re-issues the token so the new preference sticks for the rest
// of this session without forcing a re-login.
router.patch("/theme-mode", requireAuth, (req: AuthRequest, res) => {
  const { themeMode } = req.body as { themeMode: string };
  if (themeMode !== "light" && themeMode !== "dark") {
    res.status(400).json({ message: "themeMode must be 'light' or 'dark'" });
    return;
  }
  const user = db.setUserThemeMode(req.user!.id, themeMode);
  res.json({ token: signToken(user), user });
});

export default router;
