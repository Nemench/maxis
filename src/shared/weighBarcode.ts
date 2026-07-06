// Digi SM-110 (and most other retail scales') "variable price" barcodes: an
// EAN-13 the scale itself generates per-label, with the final price baked
// into the digits — not a fixed catalog barcode, so a normal exact-match
// lookup will never find it twice (the price differs every time the item
// is weighed). Confirmed against two real labels for the same product at
// different weights, which decoded to the exact same R720/kg unit price:
//
//   Sweet Chili Sticks  0.098kg  2000550070568  -> plu 00550, price R70.56
//   Sweet Chili Sticks  0.190kg  2000550136806  -> plu 00550, price R136.80
//   (70.56 / 0.098 == 136.80 / 0.190 == 720 R/kg)
//
// Layout:
//   digits 1-2:  "20"    restricted-circulation prefix flagging a
//                        scale-generated (not GS1-assigned) barcode
//   digits 3-7:  PLU     the scale's own 5-digit internal item code —
//                        store this (not the full 13-digit scan) as the
//                        product's `barcode` in the catalog
//   digits 8-12: price   Rand.cents, e.g. "07056" -> R70.56
//   digit 13:    check   standard EAN-13 check digit over digits 1-12

import { ean13CheckDigit } from "./ean13";

export interface WeighBarcode {
  plu: string;
  price: number;
}

export function parseWeighBarcode(code: string): WeighBarcode | null {
  if (!/^\d{13}$/.test(code) || !code.startsWith("20")) return null;
  if (ean13CheckDigit(code.slice(0, 12)) !== Number(code[12])) return null;
  return { plu: code.slice(2, 7), price: Number(code.slice(7, 12)) / 100 };
}
