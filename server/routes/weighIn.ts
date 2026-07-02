// Stock-in "weigh-in" workflow: the stock taker logs incoming deliveries as
// batches (one open batch at a time, auto-created on the first line added).
// Each line is one product/grade/supplier entry; finalizing a batch locks it
// and produces the numbers for the printed summary.
import { Router } from "express";
import { db } from "../index.js";
import { requireAuth, requireAdmin } from "../auth.js";
import type { AuthRequest } from "../auth.js";
import type { WeighInLineInput, Grade } from "../../src/shared/types.js";

const router = Router();
router.use(requireAuth);

// A line can be a single grade or a combined pair (e.g. mixed A/B pieces
// weighed together) — but never all three at once, so only pairs are listed.
const GRADES: Grade[] = ["A", "B", "C", "A,B", "A,C", "B,C"];
const canSubmit = (req: AuthRequest) => req.user?.role === "admin" || req.user?.role === "stock_taker";

function validateLineInput(input: WeighInLineInput): string | null {
  if (!GRADES.includes(input.grade)) return "grade must be 'A', 'B', 'C', or a pair like 'A,B'";
  if (typeof input.piecesReceived !== "number" || input.piecesReceived <= 0) return "piecesReceived must be a positive number";
  if (typeof input.weightKg !== "number" || input.weightKg <= 0) return "weightKg must be a positive number";
  if (!input.locationId) return "locationId is required";
  return null;
}

// The batch currently being built (not yet finalized), if any — drives the
// stock taker's in-progress "current batch" table.
router.get("/current", (_req, res) => {
  const batch = db.getOpenBatch();
  res.json({ batch, lines: batch ? db.listWeighInLines(batch.id) : [] });
});

// History of finalized batches, optionally filtered to a date range —
// admin-only (individual stock takers only need the current in-progress batch).
router.get("/", requireAdmin, (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    res.status(400).json({ message: "from/to must be YYYY-MM-DD" }); return;
  }
  res.json(db.listFinalizedBatches(from && to ? from : undefined, from && to ? to : undefined));
});

router.get("/:batchId", requireAdmin, (req, res) => {
  try {
    const batch = db.getBatch(Number(req.params.batchId));
    res.json({ batch, lines: db.listWeighInLines(batch.id) });
  } catch (err) {
    res.status(404).json({ message: err instanceof Error ? err.message : "Batch not found" });
  }
});

router.post("/lines", (req: AuthRequest, res) => {
  if (!canSubmit(req)) {
    res.status(403).json({ message: "Not authorized to log weigh-in lines" });
    return;
  }
  const input = req.body as WeighInLineInput;
  const error = validateLineInput(input);
  if (error) { res.status(400).json({ message: error }); return; }
  try {
    res.status(201).json(db.addWeighInLine(input, req.user!.id));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to log line" });
  }
});

router.put("/lines/:id", (req: AuthRequest, res) => {
  if (!canSubmit(req)) {
    res.status(403).json({ message: "Not authorized to edit weigh-in lines" });
    return;
  }
  const input = req.body as WeighInLineInput;
  const error = validateLineInput(input);
  if (error) { res.status(400).json({ message: error }); return; }
  try {
    res.json(db.updateWeighInLine(Number(req.params.id), input));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update line" });
  }
});

router.delete("/lines/:id", (req: AuthRequest, res) => {
  if (!canSubmit(req)) {
    res.status(403).json({ message: "Not authorized to delete weigh-in lines" });
    return;
  }
  try {
    db.deleteWeighInLine(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to delete line" });
  }
});

// Locks the batch (no further line edits/deletes) and returns its final
// lines for the printed summary. Defaults to the currently open batch if
// no batchId is given, since that's the only batch the stock taker can see.
router.post("/finalize", (req: AuthRequest, res) => {
  if (!canSubmit(req)) {
    res.status(403).json({ message: "Not authorized to finalize a batch" });
    return;
  }
  const { batchId } = req.body as { batchId?: number };
  try {
    const id = batchId ?? db.getOpenBatch()?.id;
    if (!id) { res.status(400).json({ message: "No open batch to finalize" }); return; }
    const batch = db.finalizeBatch(id);
    res.json({ batch, lines: db.listWeighInLines(batch.id) });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to finalize batch" });
  }
});

export default router;
