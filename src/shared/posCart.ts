import type { OrderItemInput, Product } from "./types";

// The single place a POS cart line's total is computed — used by every
// add/edit path (manual tile tap, barcode scan, keypad qty/weight entry)
// so none of them can drift from another.
export function calculateLineTotal(item: Pick<OrderItemInput, "wantedPrice" | "unitPrice" | "kg" | "quantity">): number | null {
  if (item.wantedPrice) return Number(item.wantedPrice.toFixed(2));
  if (!item.unitPrice) return null;
  if (item.kg) return Number((item.kg * item.unitPrice).toFixed(2));
  if (item.quantity) return Number((item.quantity * item.unitPrice).toFixed(2));
  return null;
}

// Builds the cart line for a product just added to a POS sale — the same
// function for both a manual tile tap and a barcode scan add, so there's
// no divergent "manual add" vs "scan add" code path to fall out of sync.
//
// `wantedPrice`, when given, is the price embedded in a scanned GS1
// variable-weight barcode (see weighBarcode.ts's parseWeighBarcode) — a
// Digi SM-110-style scale label bakes in the actual total price for that
// specific portion, not a per-kg rate, so this is treated as the line's
// authoritative total (calculateLineTotal returns it directly) with the
// weight back-derived from it (wantedPrice / pricePerUnit) rather than
// defaulting to a generic 1kg placeholder that would then need manual
// correction. Passing no wantedPrice (an ordinary tile tap, or a plain
// fixed-price barcode) falls back to that 1kg/1-unit default instead.
export function buildCartLine(p: Pick<Product, "id" | "name" | "pricePerUnit" | "unitDefault">, wantedPrice?: number): OrderItemInput {
  const estimatedKg = wantedPrice && p.pricePerUnit ? Number((wantedPrice / p.pricePerUnit).toFixed(3)) : 1;
  const line: OrderItemInput = {
    productId: p.id,
    name: p.name,
    notes: "",
    department: "counter",
    unitPrice: p.pricePerUnit,
    kg: p.unitDefault === "qty" ? null : estimatedKg,
    quantity: p.unitDefault === "qty" ? 1 : null,
    wantedPrice: wantedPrice ?? null,
    lineTotal: null
  };
  return { ...line, lineTotal: calculateLineTotal(line) };
}
