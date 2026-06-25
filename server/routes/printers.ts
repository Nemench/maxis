import { Router } from "express";
import { exec } from "node:child_process";
import { requireAuth, requireAdmin } from "../auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/", (_req, res) => {
  const cmd = process.platform === "win32"
    ? `wmic printer get name /format:list`
    : `lpstat -a 2>/dev/null`;

  exec(cmd, { timeout: 6000 }, (err, stdout) => {
    if (err && !stdout) { res.json([]); return; }
    let names: string[];
    if (process.platform === "win32") {
      names = stdout.split(/\r?\n/)
        .filter((l) => l.startsWith("Name="))
        .map((l) => l.replace("Name=", "").trim())
        .filter(Boolean);
    } else {
      names = stdout.split("\n")
        .filter((l) => l.trim())
        .map((l) => l.split(" ")[0].trim())
        .filter(Boolean);
    }
    res.json(names);
  });
});

export default router;
