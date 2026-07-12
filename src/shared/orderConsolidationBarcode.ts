import { ean13CheckDigit } from "./ean13";

// One barcode representing a whole order, generated only once every line
// item has been individually scanned and verified against it (see
// server/database.ts's finalizeConsolidation) — a final packing/QA check
// before handover, distinct from:
//   - the per-product barcodes this scan step itself reads
//     (internalBarcode.ts's "29" prefix / real manufacturer barcodes)
//   - the plain CODE128 ticketNumber barcode already printed on every
//     receipt (src/ui/App.tsx's buildReceiptHtml) for the unrelated
//     "scan to look this order up" feature
//
// Uses the "28" GS1 restricted-circulation (internal-use) prefix — a
// third, distinct value from "20" (weigh-scale price labels) and "29"
// (auto-generated product barcodes), so none of the three formats can
// ever be confused for one another (they all pass the same EAN-13
// checksum; only the prefix tells them apart).
//
// Layout:
//   digits 1-2:   "28"      consolidated-order prefix
//   digits 3-9:   order id  zero-padded to 7 digits (comfortably covers
//                           this app's whole lifetime of orders; throws
//                           rather than silently truncating/colliding if
//                           ever exceeded)
//   digits 10-12: "000"     reserved for future use
//   digit 13:     check     standard EAN-13 check digit (see ean13.ts)
//
// Deterministic by design, same reasoning as generateInternalBarcode: the
// same orderId always yields the same barcode, so there's no state to
// track beyond the orderId itself.
export function generateConsolidationBarcode(orderId: number): string {
  if (!Number.isInteger(orderId) || orderId < 0 || orderId > 9999999) {
    throw new Error(`generateConsolidationBarcode: orderId ${orderId} must be an integer between 0 and 9999999`);
  }
  const first12 = `28${String(orderId).padStart(7, "0")}000`;
  return first12 + ean13CheckDigit(first12);
}
