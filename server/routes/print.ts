// Server-side "silent print": writes a receipt/summary HTML document to a
// temp file and hands it to the OS's native print path so a receipt
// printer can produce a ticket without a user manually hitting Ctrl+P.
// This is separate from the browser print-to-PDF path used elsewhere
// (buildReceiptHtml/printHtml in src/ui/App.tsx) — that path is for
// on-screen preview/PDF, this one is for direct-to-printer kitchen tickets.
//
// Windows: PowerShell opens the HTML in the default browser, which does
// its own real HTML rendering — no format-mismatch risk there.
// Linux/macOS: CUPS `lp`. Renders the HTML to PDF via headless Chrome
// first (see resolveChromeBinary) — handing `lp` raw HTML only actually
// prints on a system that happens to have a working text/html CUPS
// filter installed, which most modern minimal Linux installs don't; `lp`
// would accept the job anyway (no error) and the printer would silently
// drop it, having no idea what to do with markup tags. PDF is handled
// natively by every CUPS filter chain and every IPP-capable printer
// (including driverless "IPP Everywhere" queues), so this removes the
// dependency on whichever HTML filter happens to be installed. Chrome
// specifically (not wkhtmltopdf, tried first and abandoned) because it's
// the exact rendering engine printHtml's own browser-based fallback
// already relies on — using the same engine server-side means the PDF
// can never render differently than what already looks correct in an
// on-screen print preview, and it actually supports the CSS Grid this
// app's own A4 label sheets use (wkhtmltopdf's old WebKit fork doesn't).
import { Router } from "express";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireAuth } from "../auth.js";

const router = Router();
router.use(requireAuth);

// Different distros/install methods name the binary differently — try the
// most common ones in order, or an explicit override (useful if it's
// installed somewhere non-standard, e.g. a Flatpak/snap shim). Resolved
// once per process (not per request): the binary's location doesn't
// change while the service is running, and probing several candidate
// paths on every single print would just be wasted work.
let resolvedChromeBinary: string | null | undefined;
function resolveChromeBinary(): string | null {
  if (resolvedChromeBinary !== undefined) return resolvedChromeBinary;
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium"
  ].filter((c): c is string => !!c);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" });
      resolvedChromeBinary = bin;
      return bin;
    } catch { /* try the next candidate */ }
  }
  resolvedChromeBinary = null;
  return null;
}

router.post("/", (req, res) => {
  const { printerName, html } = req.body as { printerName: string; html: string };
  // This route previously had no logging at all — a failed print left
  // zero trace in `journalctl -u nemenchpos`, indistinguishable from the
  // request never having arrived. Every branch below now logs, so a live
  // print problem is diagnosable from the server's own log without
  // needing to reproduce it through a debugger.
  console.log(`[print] request: printer="${printerName}" htmlLength=${html?.length ?? 0}`);
  if (!printerName || !html) {
    console.error(`[print] rejected: missing printerName or html`);
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
    console.error(`[print] rejected: invalid printer name "${printerName}"`);
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
  // Handing `lp` the HTML file directly used to be the whole story here, but
  // that only actually prints on a system where CUPS has a working text/html
  // filter installed — most modern minimal Linux installs don't ship one, so
  // `lp` accepts the job (no error, so this route reported success) and the
  // printer silently drops it, having no idea what to do with markup tags.
  // Converting to PDF first sidesteps that entirely: every CUPS filter chain
  // and every IPP-capable printer (including "IPP Everywhere" driverless
  // queues) handles PDF natively, so this no longer depends on which HTML
  // filter package happens to be installed on any given deployment.
  try {
    writeFileSync(tmpFile, html, "utf8");
  } catch (err) {
    res.status(500).json({ message: `Could not write temp file: ${err instanceof Error ? err.message : "unknown"}` });
    return;
  }

  const chromeBin = resolveChromeBinary();
  if (!chromeBin) {
    console.error(`[print] no Chrome/Chromium binary found (tried CHROME_BIN, google-chrome-stable, google-chrome, chromium-browser, chromium)`);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    res.status(500).json({ message: "Could not print: no Chrome/Chromium binary found on this server. Install Google Chrome (see README) or set CHROME_BIN to its path, then restart the service." });
    return;
  }
  console.log(`[print] using Chrome binary: ${chromeBin}`);

  const pdfFile = tmpFile.replace(/\.html$/, ".pdf");
  const cleanup = () => { for (const f of [tmpFile, pdfFile]) { try { unlinkSync(f); } catch { /* ignore */ } } };

  // --print-to-pdf-no-header removes Chrome's own default page
  // header/footer (URL, date, page number) that would otherwise print on
  // top of the receipt — the HTML's own @page margin (0 for a receipt/
  // label) already controls all the spacing that actually matters here.
  // --no-sandbox is required to run Chrome as root, which is how this
  // service runs by default (see install.sh's systemd unit) — Chrome
  // refuses to start as root without it.
  execFile(
    chromeBin,
    ["--headless", "--disable-gpu", "--no-sandbox", "--print-to-pdf-no-header", `--print-to-pdf=${pdfFile}`, tmpFile],
    { timeout: 20_000 },
    (renderErr) => {
      if (renderErr) {
        console.error(`[print] Chrome PDF render failed: ${renderErr.message}`);
        cleanup();
        res.status(500).json({ message: `Could not render receipt to PDF: ${renderErr.message}` });
        return;
      }
      console.log(`[print] PDF rendered OK, sending to lp -d "${printerName}"`);

      execFile("lp", ["-d", printerName, pdfFile], { timeout: 10_000 }, (printErr, stdout, stderr) => {
        cleanup();
        if (printErr) {
          console.error(`[print] lp failed: ${printErr.message}${stderr ? ` | stderr: ${stderr}` : ""}`);
          res.status(500).json({ message: `lp failed: ${printErr.message}` });
        } else {
          console.log(`[print] lp accepted the job: ${stdout.trim()}`);
          res.json({ ok: true });
        }
      });
    }
  );
});

export default router;
