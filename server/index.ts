// Express app entry point: security middleware, rate limiting, route
// mounting, and (in production) serving the built SPA + its client-side
// routing fallback. Run via `npm run start` (prod) or `npm run dev` (with
// Vite's dev server proxying to this on PORT, default 3001).
import express from "express";
import type { Request } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { KotDatabase } from "./database.js";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import productsRouter from "./routes/products.js";
import ordersRouter from "./routes/orders.js";
import settingsRouter from "./routes/settings.js";
import reportsRouter from "./routes/reports.js";
import printersRouter from "./routes/printers.js";
import printRouter from "./routes/print.js";
import backupRouter from "./routes/backup.js";
import stockRouter from "./routes/stock.js";
import suppliersRouter from "./routes/suppliers.js";
import weighInRouter from "./routes/weighIn.js";
import statisticsRouter from "./routes/statistics.js";
import crmRouter from "./routes/crm.js";
import whatsappWebhookRouter from "./routes/whatsappWebhook.js";
import { startControlPlaneSync } from "./controlPlaneSync.js";
import { startOutboxWorker } from "./whatsapp/outboxWorker.js";

export const db = new KotDatabase();
db.initialize();

// Multi-tenant control-plane sync (see controlPlaneSync.ts) — reads
// NEMENCHPOS_CONTROL_PLANE_URL/NEMENCHPOS_CONTROL_API_KEY if set, otherwise this is
// a no-op forever (a valid, fully-offline deployment mode). Never throws
// into this bootstrap; a control plane that's unreachable or never
// configured can't stop the server from starting or operating.
startControlPlaneSync();

// Drains whatsapp_outbox every 15s, sending via the Meta Graph API (see
// server/whatsapp/outboxWorker.ts). Same never-block-bootstrap posture as
// the control-plane sync — sends only happen if WHATSAPP_ACCESS_TOKEN and
// the business's whatsapp_number_id are actually configured; otherwise
// every attempt fails harmlessly and gets retried/eventually given up on.
startOutboxWorker();

const isProd = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Tell Express to trust the first proxy hop (Caddy / nginx) so
// req.ip returns the real client IP, not 127.0.0.1. Required for
// rate limiting to work correctly behind a reverse proxy.
app.set("trust proxy", 1);

app.use(compression());

// Security headers: CSP, X-Frame-Options, HSTS, X-Content-Type-Options, etc.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],  // Vite inlines small scripts
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", "data:", "blob:"],   // logo + blob: receipt windows
      connectSrc:     ["'self'"],
      fontSrc:        ["'self'", "data:"],
      objectSrc:           ["'none'"],
      frameAncestors:      ["'none'"],                // blocks clickjacking
      upgradeInsecureRequests: null,                  // disabled until HTTPS/Caddy is active
    },
  },
  crossOriginEmbedderPolicy: false, // allow blob: print tabs to open on mobile
}));

// The native Android app live-loads this server's own page directly (see
// capacitor.config.ts's server.url + src/shared/nativeServer.ts) — its API
// requests are therefore same-origin, same as an ordinary browser tab, and
// need no CORS allowance at all. Only the Vite dev server (frontend on
// :5173, API on :3001) is ever genuinely cross-origin, so there's nothing
// to allow-list in production.
const devOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
app.use(cors({ origin: isProd ? [] : devOrigins, credentials: true }));

// `verify` stashes the exact raw bytes onto req.rawBody alongside the usual
// parsed req.body — needed by the WhatsApp webhook route to check Meta's
// X-Hub-Signature-256 HMAC, which is computed over the raw request body,
// not any re-serialization of the parsed JSON (key order/whitespace would
// never match). Cheap enough to do for every request rather than scoping
// a second body parser to just that one route.
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; }
}));

// Uploaded assets (e.g. custom logo) — served from the persistent data dir, not dist/
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ── Rate limiting ─────────────────────────────────────────────────────────────

// General API limit: 300 requests/min per IP — generous for normal staff use
// but stops bots, scanners, and runaway clients dead
const apiLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many requests — please slow down." },
});

// Tight limit on backup restore: it's expensive and admin-only
const backupRestoreLimit = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many restore attempts." },
});

app.use("/api", apiLimit);
app.use("/api/backup/restore", backupRestoreLimit);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use("/api/auth",     authRouter);
app.use("/api/users",    usersRouter);
app.use("/api/products", productsRouter);
app.use("/api/orders",   ordersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/reports",  reportsRouter);
app.use("/api/printers", printersRouter);
app.use("/api/print",    printRouter);
app.use("/api/backup",   backupRouter);
app.use("/api/stock",    stockRouter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/weigh-in", weighInRouter);
app.use("/api/statistics", statisticsRouter);
app.use("/api/crm", crmRouter);
// Public — no requireAuth — Meta calls this directly and can't authenticate
// like a normal client (see server/routes/whatsappWebhook.ts's top comment
// re: signature verification not yet implemented).
app.use("/api/whatsapp", whatsappWebhookRouter);

if (isProd) {
  // Serve the Vite-built SPA and fall back to index.html for any
  // non-API route so client-side routing (React) can take over.
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`NemenchPos server → http://localhost:${PORT}`);
});
