// Print Labels: serves the DB-configured label format presets (see
// server/database.ts's label_formats schema comment) the client's
// buildThermalPrintHtml/buildA4SheetHtml renderers need. Printing itself
// happens entirely client-side (same pattern as every other receipt/label
// print in this app — see printHtml in src/ui/App.tsx) via the existing
// api.print()/printer routes, so there's nothing else to expose here.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { LabelFormatInput } from "../../src/shared/types.js";

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

// Custom sheet formats — for a brand/code this app doesn't already
// bundle a preset for (see createLabelFormat's comment). Editing/
// deleting is restricted to "custom_"-prefixed ids server-side, so these
// three routes can never touch a bundled Tower/Avery preset even if a
// client sent one of those ids by mistake.
router.post("/formats", requireAdmin, (req: AuthRequest, res) => {
  try {
    res.status(201).json(db.createLabelFormat(req.body as LabelFormatInput));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Could not create format" });
  }
});

router.put("/formats/:id", requireAdmin, (req: AuthRequest, res) => {
  try {
    res.json(db.updateLabelFormat(req.params.id as string, req.body as LabelFormatInput));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Could not update format" });
  }
});

router.delete("/formats/:id", requireAdmin, (req, res) => {
  try {
    db.deleteLabelFormat(req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Could not delete format" });
  }
});

export default router;
