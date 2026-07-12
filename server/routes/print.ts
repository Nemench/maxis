// Server-side "silent print": writes a receipt/summary HTML document to a
// temp file and hands it to the OS's native print path (CUPS `lp` on
// Linux/macOS, PowerShell + default browser on Windows), so a receipt
// printer can produce a ticket without a user manually hitting Ctrl+P.
// This is separate from the browser print-to-PDF path used elsewhere
// (buildReceiptHtml/printHtml in src/ui/App.tsx) — that path is for
// on-screen preview/PDF, this one is for direct-to-printer kitchen tickets.
import { Router } from "express";
import { exec, execFile } from "node:child_process";
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

  // Validation differs by platform:
  // Linux/macOS — CUPS names are ASCII word chars only (no shell metacharacters)
  // Windows     — names from wmic may contain spaces and parentheses; block only
  //               characters that would allow command injection
  const validPrinter = process.platform === "win32"
    ? /^[^&;|`$<>"\r\n]{1,260}$/.test(printerName)
    : /^[\w.@-]+$/.test(printerName);

  if (!validPrinter) {
    res.status(400).json({ message: "Invalid printer name" });
    return;
  }

  const tmpFile = join(tmpdir(), `nemenchpos-${Date.now()}.html`);

  // ── Windows ────────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    // Inject window.print() if the HTML doesn't already trigger it.
    const autoprint = `<script>window.addEventListener('load',function(){window.print();});</script>`;
    let printable: string;
    if (html.includes("window.print()")) {
      printable = html;
    } else if (html.includes("</head>")) {
      printable = html.replace("</head>", `${autoprint}</head>`);
    } else {
      printable = `${autoprint}${html}`;
    }

    try {
      writeFileSync(tmpFile, printable, "utf8");
    } catch (err) {
      res.status(500).json({ message: `Could not write temp file: ${err instanceof Error ? err.message : "unknown"}` });
      return;
    }

    // Convert to a file:/// URI (forward slashes required).
    const fileUri = `file:///${tmpFile.replace(/\\/g, "/")}`;

    // execFile bypasses cmd.exe so path quoting is handled by the OS, not the shell.
    // Start-Process opens the URI with the Windows default browser.
    // The injected script calls window.print() once the page loads.
    //
    // NOTE: This requires the service to run under an interactive user account,
    // not as LocalSystem (Session 0). See README for configuration details.
    execFile(
      "powershell.exe",
      ["-NonInteractive", "-Command", `Start-Process '${fileUri.replace(/'/g, "''")}'`],
      { timeout: 10_000 },
      (err) => {
        // Keep the file alive long enough for the browser to load it, then delete.
        setTimeout(() => { try { unlinkSync(tmpFile); } catch { /* ignore */ } }, 30_000);
        if (err) {
          res.status(500).json({ message: `Could not open browser for printing: ${err.message}` });
        } else {
          res.json({ ok: true });
        }
      }
    );
    return;
  }

  // ── Linux / macOS: CUPS ────────────────────────────────────────────────────
  try {
    writeFileSync(tmpFile, html, "utf8");
  } catch (err) {
    res.status(500).json({ message: `Could not write temp file: ${err instanceof Error ? err.message : "unknown"}` });
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
