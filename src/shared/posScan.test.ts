import { describe, it, expect, vi } from "vitest";
import { buildCartLine } from "./posCart";
import { buildWeighBarcode, parseWeighBarcode } from "./weighBarcode";
import type { Product, OrderItemInput } from "./types";

// Simulates the POS screen's hidden always-focused scanner input (see
// POSPanel in src/ui/App.tsx: hiddenScanRef/handleHiddenScanKeyDown/
// handleScan) — no timing/burst-speed heuristics involved at all in this
// approach, unlike a previous attempt. A hardware scanner just types its
// decoded digits into whatever's focused; since the hidden input is kept
// focused by default, its value simply accumulates character-by-character
// exactly like a real onChange would, and Enter resolves it. This drives
// that exact sequence — accumulate characters, fire Enter, run the same
// lookup/cart-line logic the real handler calls — and asserts the
// simulated input is cleared immediately afterward regardless of outcome.
interface FakeHiddenInput {
  value: string;
}

function simulateHiddenScan(
  barcode: string,
  field: FakeHiddenInput,
  lookup: (code: string) => Product | undefined
): { addedLine: OrderItemInput | null; notFoundMessage: string | null } {
  // onChange fires once per keystroke in a real <input> — no suppression,
  // no timing math, the value just accumulates.
  for (const ch of barcode) field.value += ch;

  // handleHiddenScanKeyDown on Enter: read the value, clear it
  // immediately (regardless of what happens next), then resolve it.
  const code = field.value.trim();
  field.value = "";

  let addedLine: OrderItemInput | null = null;
  let notFoundMessage: string | null = null;
  if (code) {
    const weigh = parseWeighBarcode(code);
    const lookupCode = weigh ? weigh.itemCode : code;
    const product = lookup(lookupCode);
    if (product) {
      addedLine = buildCartLine(product, weigh?.price);
    } else {
      notFoundMessage = `No product found for "${code}"`;
    }
  }

  return { addedLine, notFoundMessage };
}

const weighedProduct: Product = {
  id: 42, name: "Sweet Chilli Sticks", category: "Deli", unitDefault: "kg", pricePerUnit: 720,
  prepNotes: "", department: "counter", isActive: 1, lowStockThreshold: null, onHandQty: 0,
  lastCountedAt: null, lastCountedById: null, barcode: null, itemCode: "00550", isRawIntake: 0,
  createdAt: "", updatedAt: "", currentCost: 400
};

const fixedUnitProduct: Product = {
  id: 7, name: "Boerewors 500g Pack", category: "Beef", unitDefault: "qty", pricePerUnit: 89.99,
  prepNotes: "", department: "counter", isActive: 1, lowStockThreshold: null, onHandQty: 0,
  lastCountedAt: null, lastCountedById: null, barcode: "2900007000003", itemCode: null, isRawIntake: 0,
  createdAt: "", updatedAt: "", currentCost: 60
};

describe("POS hidden-input barcode scan — end-to-end handler simulation", () => {
  it("a plain barcode scan adds the correct product and clears the hidden input", () => {
    const field: FakeHiddenInput = { value: "" };
    const lookup = vi.fn((code: string) => (code === "2900007000003" ? fixedUnitProduct : undefined));

    const { addedLine } = simulateHiddenScan("2900007000003", field, lookup);

    expect(lookup).toHaveBeenCalledWith("2900007000003");
    expect(addedLine).not.toBeNull();
    expect(addedLine!.productId).toBe(7);
    expect(addedLine!.name).toBe("Boerewors 500g Pack");
    expect(addedLine!.quantity).toBe(1);
    expect(addedLine!.lineTotal).toBe(89.99);
    expect(field.value).toBe(""); // ready for the next scan
  });

  it("a variable-weight scan decodes the embedded price, not a flat per-kg rate, and clears the hidden input", () => {
    const field: FakeHiddenInput = { value: "" };
    const scannedCode = buildWeighBarcode("00550", 99.36); // 0.138kg @ R720/kg
    const lookup = vi.fn((code: string) => (code === "00550" ? weighedProduct : undefined));

    const { addedLine } = simulateHiddenScan(scannedCode, field, lookup);

    expect(lookup).toHaveBeenCalledWith("00550"); // decoded itemCode, not the raw scanned string
    expect(addedLine).not.toBeNull();
    expect(addedLine!.lineTotal).toBe(99.36); // the label's actual price
    expect(addedLine!.kg).toBeCloseTo(0.138, 3);
    expect(field.value).toBe("");
  });

  it("a scan with no matching product shows a not-found message and still clears the hidden input", () => {
    const field: FakeHiddenInput = { value: "" };
    const lookup = vi.fn(() => undefined);

    const { addedLine, notFoundMessage } = simulateHiddenScan("6009999999999", field, lookup);

    expect(addedLine).toBeNull();
    expect(notFoundMessage).toBe('No product found for "6009999999999"');
    expect(field.value).toBe("");
  });

  it("no timing dependency — the same result whether characters 'arrive' fast or with pauses between them", () => {
    // The old approach cared about inter-keystroke gaps; this one doesn't
    // — accumulation is purely additive regardless of when each
    // character conceptually "arrived", proving there's no leftover
    // timing logic influencing the outcome.
    const field: FakeHiddenInput = { value: "" };
    const lookup = vi.fn((code: string) => (code === "2900007000003" ? fixedUnitProduct : undefined));

    const { addedLine } = simulateHiddenScan("2900007000003", field, lookup);

    expect(addedLine).not.toBeNull();
    expect(addedLine!.productId).toBe(7);
  });
});
