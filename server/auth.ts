import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import type { User } from "../src/shared/types.js";

const SECRET = process.env.JWT_SECRET ?? "butcher-kot-local-secret";

export interface AuthRequest extends Request {
  user?: User;
}

export function signToken(user: User): string {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, department: user.department },
    SECRET,
    { expiresIn: "8h" }
  );
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) { res.status(401).json({ message: "Authentication required" }); return; }
  try {
    req.user = jwt.verify(token, SECRET) as User;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") { res.status(403).json({ message: "Admin access required" }); return; }
  next();
}
