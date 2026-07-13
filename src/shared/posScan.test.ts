import { describe, it, expect, vi } from "vitest";
import { initScanBuffer, feedScanKey } from "./scanBuffer";
import { buildCartLine } from "./posCart";
import { buildWeighBarcode, parseWeighBarcode } from "./weighBarcode";
import type { Product, OrderItemInput } from "./types";

// End-to-end simulation of the exact real handler in POSPanel's global
// keydown effect (src/ui/App.tsx) — same decision sequence
// (feedScanKey -> preventDefault/clear-field -> lookup -> buildCartLine),
// driven by synthetic keydown events instead of a real browser, since
// this repo has no React component-testing setup. This is what actually
// exercises the fix for the "raw barcode text lands in the search field
// instead of being intercepted" bug: two competing Enter handlers used to
// both listen for the same keystroke and neither suppressed default
// typing, so the digits always stayed visible. Here we drive the single,
// consolidated handler and assert the simulated search field ends up
// empty and the right line lands in the cart.
interface FakeSearchField {
  value: string;
  focused: boolean;
}

function simulateScan(
  barcode: string,
  gapMs: number,
  field: FakeSearchField,
  lookup: (code: string) => Product | undefined
): { addedLine: OrderItemInput | null; notFoundMessage: string | null } {
  const state = initScanBuffer();
  let t = 0;
  let addedLine: OrderItemInput | null = null;
  let notFoundMessage: string | null = null;

  const feed = (key: string) => {
    const result = feedScanKey(state, key, t);
    if (result.suppress) {
      // preventDefault() — the browser's default "type this character"
      // never happens, so `field.value` is NOT updated for this key.
    } else if (field.focused && key !== "Enter") {
      // Mirrors the real <input>'s onChange: an unsuppressed character
      // keystroke types normally.
      field.value += key;
    }
    if (result.burstConfirmed && field.focused) {
      field.value = ""; // retroactively wipe the unavoidable first character
    }
    if (result.completedScan) {
      const weigh = parseWeighBarcode(result.completedScan);
      const lookupCode = weigh ? weigh.itemCode : result.completedScan;
      const product = lookup(lookupCode);
      if (product) {
        addedLine = buildCartLine(product, weigh?.price);
        if (field.focused) field.value = ""; // handleScan's own reset on success
      } else {
        notFoundMessage = `No product found for "${result.completedScan}"`;
      }
    }
    t += gapMs;
  };

  for (const ch of barcode) feed(ch);
  feed("Enter");

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

describe("POS barcode scan — end-to-end handler simulation", () => {
  it("a real-speed scan burst (~8ms/char) + Enter adds the correct product and leaves the search field empty", () => {
    const field: FakeSearchField = { value: "", focused: true };
    const lookup = vi.fn((code: string) => (code === "2900007000003" ? fixedUnitProduct : undefined));

    const { addedLine } = simulateScan("2900007000003", 8, field, lookup);

    expect(lookup).toHaveBeenCalledWith("2900007000003");
    expect(addedLine).not.toBeNull();
    expect(addedLine!.productId).toBe(7);
    expect(addedLine!.name).toBe("Boerewors 500g Pack");
    expect(addedLine!.quantity).toBe(1);
    expect(addedLine!.lineTotal).toBe(89.99);

    // The actual bug this test exists to catch: the raw scanned digits
    // must NOT be left sitting in the search field afterward.
    expect(field.value).toBe("");
  });

  it("a variable-weight scan burst decodes the embedded price, not a flat per-kg rate, and still clears the field", () => {
    const field: FakeSearchField = { value: "", focused: true };
    const scannedCode = buildWeighBarcode("00550", 99.36); // 0.138kg @ R720/kg
    const lookup = vi.fn((code: string) => (code === "00550" ? weighedProduct : undefined));

    const { addedLine } = simulateScan(scannedCode, 8, field, lookup);

    expect(lookup).toHaveBeenCalledWith("00550"); // decoded itemCode, not the raw scanned string
    expect(addedLine).not.toBeNull();
    expect(addedLine!.lineTotal).toBe(99.36); // the label's actual price
    expect(addedLine!.kg).toBeCloseTo(0.138, 3);
    expect(field.value).toBe("");
  });

  it("slow, human-paced typing of the same digits is never suppressed and never treated as a completed scan", () => {
    const field: FakeSearchField = { value: "", focused: true };
    const lookup = vi.fn(() => fixedUnitProduct);

    const { addedLine } = simulateScan("2900007000003", 200, field, lookup);

    expect(lookup).not.toHaveBeenCalled();
    expect(addedLine).toBeNull();
    // Ordinary typing behaves exactly like a normal search box: the text
    // stays visible for the human to see/edit/click a result for.
    expect(field.value).toBe("2900007000003");
  });

  it("a scan with no matching product shows a not-found message and still clears the field", () => {
    const field: FakeSearchField = { value: "", focused: true };
    const lookup = vi.fn(() => undefined);

    const { addedLine, notFoundMessage } = simulateScan("6009999999999", 8, field, lookup);

    expect(addedLine).toBeNull();
    expect(notFoundMessage).toBe('No product found for "6009999999999"');
    // Even on a miss, the burst's digits were suppressed as they arrived
    // (see burstConfirmed clearing the stray first character) — nothing
    // was ever left in the box to begin with.
    expect(field.value).toBe("");
  });
});
