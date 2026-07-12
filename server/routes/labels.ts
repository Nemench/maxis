// Print Labels: serves the DB-configured label format presets (see
// server/database.ts's label_formats schema comment) the client's
// buildThermalPrintHtml/buildA4SheetHtml renderers need. Printing itself
// happens entirely client-side (same pattern as every other receipt/label
// print in this app — see printHtml in src/ui/App.tsx) via the existing
// api.print()/printer routes, so there's nothing else to expose here.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth } from "../auth.js";
import type { AuthRequest } from "../auth.js";

const router = Router();
router.use(requireAuth);

// Matches the roles named in the feature spec exactly (admin, counter).
router.use((req: AuthRequest, res, next) => {
  const role = req.user?.role;
  if (role !== "admin" && role !== "counter") { res.status(403).json({ message: "Not authorized to print labels" }); return; }
  next();
});

router.get("/formats", (_req, res) => {
  res.json(db.listLabelFormats());
});

export default router;
