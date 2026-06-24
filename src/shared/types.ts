export type OrderStatus = "New" | "Received" | "Ready" | "Done";
export type UnitDefault = "kg" | "qty" | "kg_qty";
export type Department = "kitchen" | "counter";
export type DeptStatus = "n/a" | "New" | "Received" | "Ready" | "Done";

export interface User {
  id: number;
  name: string;
  role: "admin" | "cashier" | "master_cashier" | "counter" | "kitchen";
  department: Department | null;
  isActive: number;
  createdAt: string;
}

export interface UserInput {
  name: string;
  pin: string;
  role: "admin" | "cashier" | "master_cashier" | "counter" | "kitchen";
  department: Department | null;
}

export interface Product {
  id: number;
  name: string;
  category: string;
  unitDefault: UnitDefault;
  pricePerUnit: number | null;
  prepNotes: string;
  department: Department;
  isActive: number;
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
}

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
  status: OrderStatus;
  kitchenStatus: DeptStatus;
  counterStatus: DeptStatus;
  requestedById: number | null;
  requestedByName: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}
