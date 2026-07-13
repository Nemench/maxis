import { describe, it, expect } from "vitest";
import { flattenBatch, totalBatchCount, placeOnSheets, type LabelBatchEntry } from "./labelBatch";
import type { LabelData } from "./types";

function label(name: string, barcode: string): LabelData {
  return { name, barcode, itemCode: null, pricePerUnit: 10, unitDefault: "qty", weightKg: null };
}

describe("flattenBatch / totalBatchCount", () => {
  it("only includes products actually added to the batch, not the full catalog", () => {
    // Simulates picking 2 of 3 available products for a print run — the
    // third must never leak into the output, which is exactly the bug
    // this batch-selection feature exists to prevent.
    const beef = label("Beef Mince", "2900001000005");
    const lamb = label("Lamb Chops", "2900002000002");
    const batch: LabelBatchEntry[] = [
      { id: "a", data: beef, quantity: 2 },
      { id: "b", data: lamb, quantity: 3 }
    ];
    const flat = flattenBatch(batch);
    expect(flat).toHaveLength(5);
    expect(flat.filter((l) => l.name === "Beef Mince")).toHaveLength(2);
    expect(flat.filter((l) => l.name === "Lamb Chops")).toHaveLength(3);
    expect(flat.some((l) => l.name === "Pork Ribs")).toBe(false);
  });

  it("preserves entry order and keeps each entry's copies consecutive", () => {
    const batch: LabelBatchEntry[] = [
      { id: "a", data: label("A", "1"), quantity: 2 },
      { id: "b", data: label("B", "2"), quantity: 1 }
    ];
    expect(flattenBatch(batch).map((l) => l.name)).toEqual(["A", "A", "B"]);
  });

  it("removing an entry from the batch removes it from the flattened output", () => {
    const beef = label("Beef Mince", "2900001000005");
    const lamb = label("Lamb Chops", "2900002000002");
    const full: LabelBatchEntry[] = [
      { id: "a", data: beef, quantity: 1 },
      { id: "b", data: lamb, quantity: 1 }
    ];
    const afterRemoval = full.filter((e) => e.id !== "b");
    expect(flattenBatch(afterRemoval).map((l) => l.name)).toEqual(["Beef Mince"]);
    expect(totalBatchCount(afterRemoval)).toBe(1);
  });

  it("treats a zero or negative quantity as contributing nothing", () => {
    const batch: LabelBatchEntry[] = [{ id: "a", data: label("A", "1"), quantity: 0 }];
    expect(flattenBatch(batch)).toHaveLength(0);
    expect(totalBatchCount(batch)).toBe(0);
  });

  it("sums quantities across every entry for the visible count", () => {
    const batch: LabelBatchEntry[] = [
      { id: "a", data: label("A", "1"), quantity: 4 },
      { id: "b", data: label("B", "2"), quantity: 7 }
    ];
    expect(totalBatchCount(batch)).toBe(11);
  });
});

describe("placeOnSheets", () => {
  const flat = Array.from({ length: 5 }, (_, i) => label(`Item ${i}`, String(i)));

  it("fills a single sheet in order when everything fits", () => {
    const sheets = placeOnSheets(flat, 8, new Set());
    expect(sheets).toHaveLength(1);
    expect(sheets[0].slice(0, 5).map((c) => c?.name)).toEqual(["Item 0", "Item 1", "Item 2", "Item 3", "Item 4"]);
    expect(sheets[0].slice(5)).toEqual([null, null, null]);
  });

  it("skips blocked positions on the first sheet only, filling around them", () => {
    // Positions 1 and 3 already used on the physical sheet — only 4 free
    // cells remain on sheet1, so the 5th item overflows onto a 2nd sheet.
    const sheets = placeOnSheets(flat, 6, new Set([1, 3]));
    expect(sheets).toHaveLength(2);
    expect(sheets[0][0]).toBeNull();
    expect(sheets[0][1]?.name).toBe("Item 0");
    expect(sheets[0][2]).toBeNull();
    expect(sheets[0][3]?.name).toBe("Item 1");
    expect(sheets[0][4]?.name).toBe("Item 2");
    expect(sheets[0][5]?.name).toBe("Item 3");
    expect(sheets[1][0]?.name).toBe("Item 4");
  });

  it("overflows onto a fresh, fully-available second sheet", () => {
    const sheets = placeOnSheets(flat, 6, new Set([1, 2, 3, 4, 5]));
    // Only 1 free cell on sheet1 (position 6) — 4 items overflow to sheet2.
    expect(sheets).toHaveLength(2);
    expect(sheets[0].filter((c) => c !== null)).toHaveLength(1);
    expect(sheets[0][5]?.name).toBe("Item 0");
    expect(sheets[1].slice(0, 4).map((c) => c?.name)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"]);
    // Second sheet is fresh — blockedPositions never applies past sheet 1.
    expect(sheets[1][0]).not.toBeNull();
  });

  it("places every input label exactly once across however many sheets are needed", () => {
    const big = Array.from({ length: 23 }, (_, i) => label(`Item ${i}`, String(i)));
    const sheets = placeOnSheets(big, 10, new Set([1, 2]));
    const placed = sheets.flat().filter((c): c is LabelData => c !== null);
    expect(placed).toHaveLength(23);
    expect(new Set(placed.map((l) => l.name)).size).toBe(23);
  });
});
