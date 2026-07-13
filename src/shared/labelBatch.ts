import type { LabelData } from "./types";

// One row in a print batch: a specific product's label data plus how many
// copies of it to print. Kept as its own type (rather than reusing
// LabelData with a bolted-on count) so a batch entry can carry a stable
// `id` distinct from the product id — the same product can be added to a
// batch twice (e.g. two different weighed portions), and each row needs
// its own identity for React keys / removal, independent of productId.
export interface LabelBatchEntry {
  id: string;
  data: LabelData;
  quantity: number;
}

// Expands a batch (several different products, each with its own copy
// count) into one flat, ordered list of individual labels — the order
// entries were added is preserved, and within an entry its copies are
// consecutive. This is the single source of truth for "what actually
// gets printed": the sheet renderer, the thermal renderer, and the
// visible "X labels selected" count all derive from this same flattening,
// so they can never drift out of sync with each other or with whichever
// products are actually still in the batch (the root cause a batch-
// selection UI usually gets wrong: printing from a stale copy of the
// selection instead of the current one).
export function flattenBatch(entries: LabelBatchEntry[]): LabelData[] {
  const flat: LabelData[] = [];
  for (const entry of entries) {
    const n = Math.max(0, Math.round(entry.quantity) || 0);
    for (let i = 0; i < n; i++) flat.push(entry.data);
  }
  return flat;
}

export function totalBatchCount(entries: LabelBatchEntry[]): number {
  return entries.reduce((sum, e) => sum + Math.max(0, Math.round(e.quantity) || 0), 0);
}

// Splits a flat, ordered list of labels across one or more sheets of
// `perSheet` cells, skipping `blockedPositions` (1-based, reading order)
// on the FIRST sheet only — every sheet after that is fresh and fully
// available (see buildA4SheetHtml in App.tsx, which this mirrors).
// Returns one array per sheet, each exactly `perSheet` entries long, with
// `null` marking an empty/blocked cell.
export function placeOnSheets(flat: LabelData[], perSheet: number, blockedPositions: ReadonlySet<number>): (LabelData | null)[][] {
  if (perSheet <= 0) return [];
  const available1 = Math.max(0, perSheet - blockedPositions.size);
  const sheetCount = Math.max(1, available1 >= flat.length ? 1 : 1 + Math.ceil((flat.length - available1) / perSheet));
  const sheets: (LabelData | null)[][] = [];
  let cursor = 0;
  for (let s = 0; s < sheetCount; s++) {
    const sheet: (LabelData | null)[] = [];
    for (let pos = 1; pos <= perSheet; pos++) {
      const isBlocked = s === 0 && blockedPositions.has(pos);
      if (!isBlocked && cursor < flat.length) {
        sheet.push(flat[cursor]);
        cursor++;
      } else {
        sheet.push(null);
      }
    }
    sheets.push(sheet);
  }
  return sheets;
}
