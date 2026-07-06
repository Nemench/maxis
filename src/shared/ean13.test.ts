import { describe, it, expect } from "vitest";
import { ean13CheckDigit } from "./ean13";
import { generateInternalBarcode } from "./internalBarcode";
import { parseWeighBarcode } from "./weighBarcode";

describe("ean13CheckDigit", () => {
  it("matches a well-known real-world EAN-13 (Wikipedia's canonical example)", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // full code 4006381333931
  });

  it("matches another commonly-cited textbook EAN-13", () => {
    expect(ean13CheckDigit("590123412345")).toBe(7); // full code 5901234123457
  });

  it("matches two real Digi SM-110 scale labels for the same product at different weights", () => {
    // Sweet Chili Sticks, 0.098kg and 0.190kg — both R720/kg, confirming
    // the checksum (and the weigh-barcode layout) against real hardware.
    expect(ean13CheckDigit("200055007056")).toBe(8); // full code 2000550070568
    expect(ean13CheckDigit("200055013680")).toBe(6); // full code 2000550136806
  });
});

describe("generateInternalBarcode", () => {
  it("produces a 13-digit code starting with the internal-use prefix 29", () => {
    const code = generateInternalBarcode(42);
    expect(code).toMatch(/^\d{13}$/);
    expect(code.startsWith("29")).toBe(true);
  });

  it("zero-pads the product ID into digits 3-7", () => {
    expect(generateInternalBarcode(42).slice(2, 7)).toBe("00042");
    expect(generateInternalBarcode(1).slice(2, 7)).toBe("00001");
    expect(generateInternalBarcode(99999).slice(2, 7)).toBe("99999");
  });

  it("is deterministic — regenerating for the same product ID gives the identical barcode", () => {
    expect(generateInternalBarcode(7)).toBe(generateInternalBarcode(7));
  });

  it("produces different barcodes for different product IDs", () => {
    expect(generateInternalBarcode(1)).not.toBe(generateInternalBarcode(2));
  });

  it("carries a valid EAN-13 check digit", () => {
    const code = generateInternalBarcode(123);
    expect(Number(code[12])).toBe(ean13CheckDigit(code.slice(0, 12)));
  });

  it("rejects a product ID that can't fit the 5-digit field", () => {
    expect(() => generateInternalBarcode(100000)).toThrow();
    expect(() => generateInternalBarcode(-1)).toThrow();
    expect(() => generateInternalBarcode(1.5)).toThrow();
  });

  it("is never misread as a weigh-barcode by parseWeighBarcode (the two formats must stay distinguishable)", () => {
    const code = generateInternalBarcode(550); // same numeric ID as the real PLU "00550" used elsewhere
    expect(parseWeighBarcode(code)).toBeNull();
  });
});
