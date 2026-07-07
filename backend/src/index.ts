import "dotenv/config";
import express from "express";
import cors from "cors";
import { router as mantleRouter } from "./routes/mantle.js";
import { router as sentinelRouter } from "./routes/sentinel.js";
import { router as declarationsRouter } from "./routes/declarations.js";
import { startSentinel } from "./services/sentinel.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// Behind Railway's proxy, req.ip must reflect the client (rate limiting), not the LB.
app.set("trust proxy", 1);

// Token-gated (404 when ADMIN_TOKEN unset). Mounted before the origin-restricted
// CORS below on purpose — see routes/declarations.ts.
app.use("/api/sentinel/declarations", declarationsRouter);

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:4173"];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

app.use("/api/mantle", mantleRouter);
app.use("/api/sentinel", sentinelRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);

  // The Sentinel runs autonomously — always on.
  startSentinel();
});
