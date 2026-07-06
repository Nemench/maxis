// Standard EAN-13 check digit algorithm, shared by every barcode format
// this app generates or parses (see weighBarcode.ts and internalBarcode.ts)
// so the checksum math lives in exactly one place.
//
// Digits 1-12 (left to right, 1-indexed): odd positions x1, even positions
// x3; sum, then check digit = (10 - (sum mod 10)) mod 10. Validated against
// real-world barcodes in ean13.test.ts.
export function ean13CheckDigit(first12Digits: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(first12Digits[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}
