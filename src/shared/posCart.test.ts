import { describe, it, expect } from "vitest";
import { buildCartLine, calculateLineTotal } from "./posCart";
import { buildWeighBarcode } from "./weighBarcode";
import { parseWeighBarcode } from "./weighBarcode";
import type { Product } from "./types";

const fixedUnitProduct: Pick<Product, "id" | "name" | "pricePerUnit" | "unitDefault"> = {
  id: 1, name: "Boerewors 500g Pack", pricePerUnit: 89.99, unitDefault: "qty"
};

const weighedProduct: Pick<Product, "id" | "name" | "pricePerUnit" | "unitDefault"> = {
  id: 2, name: "Sweet Chilli Sticks", pricePerUnit: 720, unitDefault: "kg"
};

describe("buildCartLine", () => {
  it("a manually-tapped fixed-unit product gets quantity 1 at its listed price", () => {
    const line = buildCartLine(fixedUnitProduct);
    expect(line.quantity).toBe(1);
    expect(line.kg).toBeNull();
    expect(line.lineTotal).toBe(89.99);
  });

  it("a manually-tapped weighed product defaults to 1kg pending real weight entry", () => {
    const line = buildCartLine(weighedProduct);
    expect(line.kg).toBe(1);
    expect(line.quantity).toBeNull();
    expect(line.lineTotal).toBe(720);
  });

  // The core "don't misread a variable-weight scan as a flat per-unit
  // price" case this feature exists to get right: a real Digi SM-110
  // scale label for 0.138kg of a R720/kg item is baked in as a TOTAL
  // price of R99.36 on the label itself, not "R720". Decoding that label
  // and adding it to the cart must produce a line priced at R99.36 for
  // 0.138kg — not R720 (the raw per-kg rate) and not R720 x 1kg (the
  // manual-tap default).
  it("decodes a scanned variable-weight barcode's embedded price correctly, not as a flat per-unit rate", () => {
    const weighBarcode = buildWeighBarcode("00550", 99.36); // 0.138kg @ R720/kg, price baked in per label
    const decoded = parseWeighBarcode(weighBarcode);
    expect(decoded).not.toBeNull();
    expect(decoded!.price).toBe(99.36);

    const line = buildCartLine(weighedProduct, decoded!.price);
    expect(line.lineTotal).toBe(99.36); // the label's actual price, not 720
    expect(line.kg).toBeCloseTo(0.138, 3); // back-derived from price / rate
    expect(line.wantedPrice).toBe(99.36);
  });

  it("a fixed-unit product ignores any wantedPrice for its weight/quantity fields (still quantity-based)", () => {
    const line = buildCartLine(fixedUnitProduct, 50);
    expect(line.quantity).toBe(1);
    expect(line.kg).toBeNull();
    expect(line.lineTotal).toBe(50); // wantedPrice still wins for the total
  });
});

describe("calculateLineTotal", () => {
  it("prefers an explicit wantedPrice over recomputing from kg/quantity x unitPrice", () => {
    expect(calculateLineTotal({ wantedPrice: 42.5, unitPrice: 100, kg: 1, quantity: null })).toBe(42.5);
  });

  it("falls back to kg x unitPrice when there's no wantedPrice", () => {
    expect(calculateLineTotal({ wantedPrice: null, unitPrice: 720, kg: 0.138, quantity: null })).toBe(99.36);
  });

  it("returns null when there's nothing to compute from", () => {
    expect(calculateLineTotal({ wantedPrice: null, unitPrice: null, kg: null, quantity: null })).toBeNull();
  });
});
