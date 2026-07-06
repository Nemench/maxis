import { ean13CheckDigit } from "./ean13";

// Auto-generated fixed barcode for a catalog product that has no real
// printed one (e.g. a deli item with no manufacturer barcode) — assigned
// on save so every product is scannable, not just ones with a barcode
// someone bothered to enter.
//
// Uses the "29" GS1 restricted-circulation (internal-use) prefix —
// deliberately NOT "20". That prefix is already claimed in this app by
// Digi-style scale weigh-labels (see weighBarcode.ts), where digits 3-7
// are a PLU and digits 8-12 are a price baked in per label. Reusing "20"
// here would make every auto-generated barcode misparse as a weigh-label
// the instant it's scanned (both formats pass the same checksum check —
// only the prefix tells them apart). "29" keeps the two formats
// unambiguous while staying inside the same reserved 20-29 range, so
// there's still no risk of colliding with a real manufacturer barcode.
//
// Layout:
//   digits 1-2:  "29"        internal-use prefix (this app's own, distinct
//                            from "20"'s weigh-label meaning)
//   digits 3-7:  product ID  zero-padded to 5 digits (so productId must be
//                            0-99999 — comfortably enough for a single-shop
//                            catalog; throws rather than silently
//                            truncating/colliding if ever exceeded)
//   digits 8-12: "00000"     reserved for future use
//   digit 13:    check       standard EAN-13 check digit (see ean13.ts)
//
// Deterministic by design: the same productId always yields the same
// barcode, so "regenerate" (e.g. after a damaged sticker) is just calling
// this again — no state to track, nothing that can drift.
export function generateInternalBarcode(productId: number): string {
  if (!Number.isInteger(productId) || productId < 0 || productId > 99999) {
    throw new Error(`generateInternalBarcode: productId ${productId} must be an integer between 0 and 99999`);
  }
  const first12 = `29${String(productId).padStart(5, "0")}00000`;
  return first12 + ean13CheckDigit(first12);
}
