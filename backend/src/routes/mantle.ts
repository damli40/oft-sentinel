import { Router } from "express";
import type { Request, Response } from "express";
import { getSentinelWatchlist, MANTLE_SENTINEL_QUERY_ID } from "../services/dune.js";

export const router = Router();

// GET /api/mantle/ofts  — OFTs active in the last 7 days (10+ messages), the sentinel watchlist.
// ?refresh=true bypasses the in-memory cache.
router.get("/ofts", async (req: Request, res: Response) => {
  try {
    const force = req.query.refresh === "true";
    const ofts = await getSentinelWatchlist(force);
    res.json({
      queryId: MANTLE_SENTINEL_QUERY_ID,
      source: "https://dune.com/queries/" + MANTLE_SENTINEL_QUERY_ID,
      count: ofts.length,
      ofts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(502).json({ error: message });
  }
});
