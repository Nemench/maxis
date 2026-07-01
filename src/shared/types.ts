// Shared type definitions, imported by both the Express server and the React
// client so request/response shapes can never drift between the two.

export type OrderStatus = "New" | "Received" | "Ready" | "Done";
export type UnitDefault = "kg" | "qty" | "kg_qty";
export type Department = "kitchen" | "counter";
// Per-department status; "n/a" marks a department an order never touched
// (e.g. counterStatus is "n/a" for an order with only kitchen items), which
// keeps it from blocking that order's overall status computation.
export type DeptStatus = "n/a" | "New" | "Received" | "Ready" | "Done";

// ── Users ────────────────────────────────────────────────────────────────────

export type Role = "admin" | "cashier" | "master_cashier" | "counter" | "kitchen" | "stock_taker";

export interface User {
  id: number;
  name: string;
  role: Role;
  department: Department | null;
  isActive: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface UserInput {
  name: string;
  pin: string;
  role: Role;
  department: Department | null;
}

// ── Products & stock ─────────────────────────────────────────────────────────

export interface Product {
  id: number;
  name: string;
  category: string;
  unitDefault: UnitDefault;
  pricePerUnit: number | null;
  prepNotes: string;
  department: Department;
  isActive: number;
  lowStockThreshold: number | null;
  onHandQty: number;
  lastCountedAt: string | null;
  lastCountedById: number | null;
  barcode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductInput {
  id?: number;
  name: string;
  category: string;
  unitDefault: UnitDefault;
  pricePerUnit: number | null;
  prepNotes: string;
  department: Department;
  lowStockThreshold: number | null;
  barcode?: string | null;
}

// Minimal fields needed to quick-create a product from an unrecognized
// barcode scan at the register — everything else defaults sensibly
// server-side (see db.quickCreateProductByBarcode).
export interface QuickCreateProductInput {
  name: string;
  barcode: string;
  pricePerUnit: number | null;
  department: Department;
}

// ── Weigh-in (stock-taking) ──────────────────────────────────────────────────
// A single grade, or a combined pair for pieces weighed together as one lot.
// All three grades combined ("A,B,C") is intentionally not a valid value.
export type Grade = "A" | "B" | "C" | "A,B" | "A,C" | "B,C";
export type BatchStatus = "open" | "finalized";

export interface Supplier {
  id: number;
  name: string;
  isActive: number;
  createdAt: string;
}

export interface WeighInBatch {
  id: number;
  status: BatchStatus;
  createdById: number | null;
  createdByName: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface WeighInBatchSummary extends WeighInBatch {
  lineCount: number;
  totalPieces: number;
  totalKg: number;
  supplierNames: string | null;
  productNames: string | null;
}

export interface WeighInLineInput {
  productId: number;
  grade: Grade;
  piecesReceived: number;
  weightKg: number;
  supplierId: number;
}

export interface WeighInLine extends WeighInLineInput {
  id: number;
  batchId: number;
  productName: string | null;
  supplierName: string | null;
  createdById: number | null;
  createdByName: string | null;
  createdAt: string;
}

// ── Orders (KOT tickets) ─────────────────────────────────────────────────────

export interface OrderItemInput {
  productId?: number | null;
  name: string;
  kg: number | null;
  quantity: number | null;
  notes: string;
  unitPrice?: number | null;
  lineTotal?: number | null;
  department: Department;
}

export interface OrderItem extends OrderItemInput {
  id: number;
  orderId: number;
}

export interface DeliveryAddress {
  street: string;
  area: string;
  buildingType: "house" | "building" | "";
  apartment: string;
}

export interface CreateOrderInput {
  customerName: string;
  customerPhone: string;
  orderType: "pickup" | "delivery";
  deliveryAddress: DeliveryAddress;
  requestedTime: string;
  assignedTo: string;
  items: OrderItemInput[];
}

export interface Order {
  id: number;
  ticketNumber: string;
  customerName: string;
  customerPhone: string;
  orderType: "pickup" | "delivery";
  deliveryAddress: DeliveryAddress;
  requestedTime: string;
  assignedTo: string | null;
  status: OrderStatus;
  kitchenStatus: DeptStatus;
  counterStatus: DeptStatus;
  requestedById: number | null;
  requestedByName: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}
