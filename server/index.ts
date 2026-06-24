import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KotDatabase } from "./database.js";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import productsRouter from "./routes/products.js";
import ordersRouter from "./routes/orders.js";

export const db = new KotDatabase();
db.initialize();

const isProd = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

if (!isProd) {
  // Dev: Vite runs separately on 5173, allow its origin
  app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"], credentials: true }));
}

app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);

if (isProd) {
  // Serve built React app
  const dist = path.join(__dirname, "../dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MAXIS server → http://localhost:${PORT}`);
});
