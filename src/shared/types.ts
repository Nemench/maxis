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
  themeMode: "light" | "dark" | null;
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
  // Whole-carcass/organ items the butchery actually takes delivery of
  // (Whole Forequarter, Liver, Lungs, Oxtail, Whole Lamb, Lamb Hind) —
  // only these appear as selectable items in the Weigh-In receiving flow.
  // Everything else (cut/prepped sellable products) is received some
  // other way, not through Weigh-In.
  isRawIntake: number;
  createdAt: string;
  updatedAt: string;
  // Derived from product_cost_history (most recent row), not a column on
  // this table — null means no cost has ever been recorded, which blocks
  // the item from being sold via POS (see requireCostPrice) and surfaces
  // it in the admin "Products needing cost price" list.
  currentCost: number | null;
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
  isRawIntake?: number;
  // Submitting a value here appends a new product_cost_history row (see
  // setProductCost) rather than updating a plain column — omitting it
  // (undefined) leaves the existing cost history untouched, so editing
  // unrelated fields on an old product never silently overwrites its cost.
  costPerUnit?: number | null;
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

// ── Stock locations ──────────────────────────────────────────────────────────
// Physical places stock can sit (Cold Room, Counter, Freezer 2, ...). Every
// product's stock is tracked per location (see ProductStockRow) rather than
// as a single overall number — Product.onHandQty is the sum across all
// locations, kept for anything that only needs the total.

export interface StockLocation {
  id: number;
  name: string;
  isActive: number;
  createdAt: string;
}

// One product's quantity at one specific location — the unit the Stock Take
// screen actually reads/writes. Nobody edits `qty` directly: entering a
// physical count (see the count endpoint) computes and applies the delta
// server-side, so there's no path to blindly overwrite the stored total.
export interface ProductStockRow {
  productId: number;
  productName: string;
  category: string;
  locationId: number;
  qty: number;
  lastCountedAt: string | null;
  lastCountedById: number | null;
  lastCountedByName: string | null;
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
  locationId: number;
}

export interface WeighInLine extends WeighInLineInput {
  id: number;
  batchId: number;
  productName: string | null;
  supplierName: string | null;
  locationName: string | null;
  createdById: number | null;
  createdByName: string | null;
  createdAt: string;
}

// ── Cut yield estimates ──────────────────────────────────────────────────────
// Configured per raw-intake product (e.g. Whole Forequarter): what % of its
// received weight typically becomes each cut/sub-product (Mince, Steak, ...).
// Doesn't need to sum to 100% — the remainder is bone/trim/waste, untracked.

export interface YieldEstimate {
  id: number;
  rawProductId: number;
  subProductId: number;
  subProductName: string;
  yieldPct: number;
}

export interface YieldEstimateInput {
  subProductId: number;
  yieldPct: number;
}

// One line of a pending conversion's estimated breakdown — editable before
// applying (the estimate is a starting point, not a guarantee the actual
// cutting matches it exactly).
export interface PendingYieldItem {
  id: number;
  subProductId: number;
  subProductName: string;
  estimatedKg: number;
  yieldPct: number;
}

// Created automatically when a Weigh-In line is logged for a raw-intake
// product that has yield estimates configured — but nothing is added to
// any sub-product's stock until someone explicitly applies it (see
// applyYieldConversion). Never auto-committed.
export interface PendingYieldConversion {
  id: number;
  weighInLineId: number | null;
  rawProductId: number;
  rawProductName: string;
  weightKgReceived: number;
  locationId: number;
  locationName: string | null;
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
  resolvedById: number | null;
  resolvedByName: string | null;
  items: PendingYieldItem[];
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
  // Customer-requested rand value instead of a weight (e.g. "R100 of mince") —
  // when set, it drives lineTotal directly and kg may be auto-estimated from
  // it, left as entered, or empty until the item is actually weighed.
  wantedPrice?: number | null;
  department: Department;
}

export interface OrderItem extends OrderItemInput {
  id: number;
  orderId: number;
  // Total cost for this line, snapshotted from product_cost_history at the
  // moment the sale was made (not looked up live) — so a later cost change
  // never silently rewrites a past sale's margin. Null for free-text lines
  // (no productId) or sales made before this feature existed.
  costAtSale: number | null;
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
  // Set by the POS checkout screen: items are already paid for and handed
  // over on the spot, so the order is created already Done (History) rather
  // than New (Queue) — there's no prep step left for anyone to action.
  completeImmediately?: boolean;
  // A flat rand amount off the item subtotal, entered at POS checkout.
  // Stored on the order itself (not applied to individual line prices) so
  // it stays a distinct, auditable figure on the tax invoice/receipt and
  // in reporting, rather than silently baked into item prices.
  discountAmount?: number;
  // How the POS sale was paid — a plain record for reporting/reconciliation,
  // not an actual payment integration (this app never touches card data).
  paymentMethod?: "cash" | "card";
  // What the customer physically handed over, for cash sales only — the
  // change due is derived from this minus the total, not stored separately.
  cashTendered?: number | null;
  // Optional "Customer number" from POS checkout — a bare phone number,
  // not a contact id. Server resolves-or-creates a crm_contacts row and
  // links the order to it; left blank, the order stays unlinked and
  // nothing CRM-related happens (see db.createOrder's handling).
  customerNumber?: string | null;
  // Optional "Customer email" from checkout — independent of the CRM/
  // WhatsApp system above (see server/email/). Left blank, no email is
  // ever sent; providing it is the opt-in.
  customerEmail?: string | null;
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
  discountAmount: number;
  paymentMethod: "cash" | "card";
  cashTendered: number | null;
  crmContactId: string | null;
  customerEmail: string | null;
  items: OrderItem[];
}

// ── Statistics (admin) ───────────────────────────────────────────────────────

// One item's sales performance within a date range — aggregated across
// order_items by name (not productId, since free-text order lines never
// have one) so it covers every item that's ever been sold, catalog or not.
export interface ItemSalesStat {
  name: string;
  totalQty: number;
  totalKg: number;
  totalRevenue: number;
  orderCount: number;
}

// One raw-intake item's received quantity within a date range (from
// Weigh-In), alongside its live current on-hand total — "how much came in
// vs. what's actually here now."
export interface ItemStockMovementStat {
  productId: number;
  productName: string;
  totalPiecesReceived: number;
  totalKgReceived: number;
  currentOnHand: number;
  lowStockThreshold: number | null;
}

// Headline KPIs + breakdowns for the Statistics overview dashboard.
// `prev*` figures cover the immediately preceding period of equal length
// (e.g. asking for the last 7 days also compares against the 7 days before
// that), so the client can show a %-change per KPI without a second round trip.
export interface StatisticsOverview {
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  totalKg: number;
  totalQty: number;
  prevRevenue: number;
  prevOrders: number;
  prevAvgOrderValue: number;
  revenueByDay: { date: string; revenue: number; orders: number }[];
  revenueByDept: { department: string; revenue: number }[];
  revenueByOrderType: { orderType: string; revenue: number }[];
  ordersByStatus: { status: string; count: number }[];
}

// One row of the margins breakdown — grouped by product, category, or day
// depending on the request (see GET /api/statistics/margins). Weighted by
// actual rand revenue/profit (total profit / total revenue for the group),
// not an unweighted average of each sale's margin_pct — a handful of
// high-margin small sales shouldn't outweigh the bulk of real revenue.
export interface MarginStat {
  id: string;
  label: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  qtySold: number;
}

export interface MarginOverview {
  current: MarginStat[];
  // Store-wide weighted average margin for the period, plus the same
  // figure for the immediately preceding period of equal length (see the
  // same pattern in StatisticsOverview) so the client can show a %-point
  // change without a second request.
  overallMarginPct: number;
  prevOverallMarginPct: number;
  trend: { date: string; revenue: number; cost: number; profit: number; marginPct: number }[];
}

// ── CRM + WhatsApp automation ────────────────────────────────────────────────
// Column names in the SQL schema are snake_case (server/database.ts) — these
// TS types are the camelCase shape every query aliases into, matching every
// other table in this app.

export type ConsentStatus = "opted_in" | "opted_out" | "unknown";
export type MessageDirection = "inbound" | "outbound";
export type MessageType = "template" | "freeform";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface CrmContact {
  id: string;
  fullName: string | null;
  phoneNumber: string;
  linkedCustomerId: string | null;
  consentStatus: ConsentStatus;
  consentRecordedAt: string | null;
  notes: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CrmContactInput {
  fullName?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface CrmTag {
  id: string;
  name: string;
}

export interface CrmMessage {
  id: string;
  contactId: string;
  direction: MessageDirection;
  messageType: MessageType;
  templateName: string | null;
  body: string;
  status: MessageStatus;
  triggeredBy: string | null;
  waMessageId: string | null;
  createdAt: string;
}

export interface WhatsappOutboxItem {
  id: string;
  contactId: string;
  templateName: string | null;
  templateParams: string | null;
  freeformBody: string | null;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export interface CrmAutomationRule {
  id: string;
  eventName: string;
  templateName: string;
  enabled: number;
}

// Independent of the CRM/WhatsApp tables above — see server/email/.
export interface EmailOutboxItem {
  id: string;
  orderId: number | null;
  toEmail: string;
  subject: string;
  body: string;
  htmlBody: string | null;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

// Auto-captured from orders' customerName/customerEmail at checkout (see
// KotDatabase.upsertEmailSubscriber) so admins have a ready-made mailing
// list for news/deals campaigns without re-typing it by hand. Independent
// of EmailOutboxItem (order receipts) and CrmContact (phone/WhatsApp).
export interface EmailSubscriber {
  id: string;
  name: string | null;
  email: string;
  status: "subscribed" | "unsubscribed";
  source: string;
  createdAt: string;
  updatedAt: string;
}

// Optional "picture-style" discount banner for a campaign email (see
// server/email/campaign.ts) — all fields optional, purely promotional
// copy/imagery, not wired into checkout/orders in any way.
export interface CampaignPromo {
  headline?: string;
  discountLabel?: string;
  description?: string;
  validUntil?: string;
  imageUrl?: string;
}

// A contact plus enough context for the admin CRM "send message" box to
// decide what it's allowed to show — computed server-side (see GET
// /api/crm/contacts/:id) rather than the client re-deriving the 24h
// service-window rule itself.
export interface CrmContactDetail {
  contact: CrmContact;
  messages: CrmMessage[];
  // Whether the most recent inbound message was within the last 24h — a
  // freeform reply is only ever allowed within that window (Meta's own
  // rule); outside it, only an approved template can be sent.
  withinServiceWindow: boolean;
}
