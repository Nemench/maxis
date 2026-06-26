import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
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

export const db = new KotDatabase();
db.initialize();

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
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],                     // blocks clickjacking
    },
  },
  crossOriginEmbedderPolicy: false, // allow blob: print tabs to open on mobile
}));

if (!isProd) {
  app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"], credentials: true }));
}

app.use(express.json({ limit: "10mb" }));

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

if (isProd) {
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MAXIS server → http://localhost:${PORT}`);
});
