import { Router, json, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { timingSafeEqual } from "crypto";
import { readDeclarations, validateDeclarations, writeDeclarations } from "../services/custody-admin.js";

// Operator-only API for the custody declarations file. Mounted BEFORE the
// app-level origin-restricted CORS: the bearer token is the security boundary
// here (no cookies), and a locally-served editor page must be able to reach a
// deployed backend without widening CORS_ORIGINS for the whole app.
export const router = Router();

router.use(cors());
router.use(json());

// When ADMIN_TOKEN is unset the API does not exist: 404, not 401, so an
// unconfigured deployment exposes no hint that a write surface is available.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(404).json({ error: "not found" });

  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

router.get("/", requireAdmin, (_req: Request, res: Response) => {
  res.json(readDeclarations());
});

// Full-file replace. PUT {} is the removal path.
router.put("/", requireAdmin, (req: Request, res: Response) => {
  // Without this guard, a PUT missing the JSON content-type parses to {} and
  // would silently wipe every declaration.
  if (!req.is("application/json")) {
    return res.status(400).json({ error: "content-type must be application/json" });
  }
  const reason = validateDeclarations(req.body);
  if (reason) return res.status(400).json({ error: reason });

  writeDeclarations(req.body);
  res.json(req.body);
});
