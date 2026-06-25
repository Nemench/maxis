import { Router } from "express";
import { exec } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireAuth } from "../auth.js";

const router = Router();
router.use(requireAuth);

router.post("/", (req, res) => {
  const { printerName, html } = req.body as { printerName: string; html: string };
  if (!printerName || !html) {
    res.status(400).json({ message: "printerName and html are required" });
    return;
  }

  const tmpFile = join(tmpdir(), `maxis-${Date.now()}.html`);
  try {
    writeFileSync(tmpFile, html, "utf8");
  } catch (err) {
    res.status(500).json({ message: `Could not write temp file: ${err instanceof Error ? err.message : "unknown"}` });
    return;
  }

  // Linux/macOS: CUPS via lp. Windows: not supported server-side.
  if (process.platform === "win32") {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    res.status(422).json({ message: "Server-side printing is not supported on Windows. Use the browser print dialog." });
    return;
  }

  exec(`lp -d "${printerName}" "${tmpFile}"`, { timeout: 10_000 }, (err) => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    if (err) {
      res.status(500).json({ message: `lp failed: ${err.message}` });
    } else {
      res.json({ ok: true });
    }
  });
});

export default router;
