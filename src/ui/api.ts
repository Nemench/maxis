import type { User, UserInput, Product, ProductInput, Order, CreateOrderInput, OrderStatus, Department, DeptStatus } from "../shared/types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem("kot-token");
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    sessionStorage.removeItem("kot-token");
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    login: (name: string, pin: string) => req<{ token: string; user: User }>("POST", "/auth/login", { name, pin }),
    me: () => req<User>("GET", "/auth/me")
  },
  users: {
    list: () => req<User[]>("GET", "/users"),
    create: (data: UserInput) => req<User>("POST", "/users", data),
    update: (id: number, data: Partial<UserInput & { isActive: number }>) => req<User>("PATCH", `/users/${id}`, data)
  },
  products: {
    list: () => req<Product[]>("GET", "/products"),
    save: (data: ProductInput) =>
      data.id ? req<Product>("PUT", `/products/${data.id}`, data) : req<Product>("POST", "/products", data),
    delete: (id: number) => req<void>("DELETE", `/products/${id}`)
  },
  orders: {
    list: (scope: string) => req<Order[]>("GET", `/orders?scope=${scope}`),
    create: (data: CreateOrderInput) => req<Order>("POST", "/orders", data),
    get: (id: number) => req<Order>("GET", `/orders/${id}`),
    updateStatus: (id: number, status: OrderStatus) => req<Order>("PATCH", `/orders/${id}/status`, { status }),
    updateDeptStatus: (id: number, department: Department, status: DeptStatus) =>
      req<Order>("PATCH", `/orders/${id}/dept-status`, { department, status }),
    export: (from: string, to: string) =>
      req<Order[]>("GET", `/reports?from=${from}&to=${to}`)
  },
  settings: {
    get: () => req<Record<string, string>>("GET", "/settings"),
    set: (data: Record<string, string>) => req<Record<string, string>>("PUT", "/settings", data)
  },
  printers: {
    list: () => req<string[]>("GET", "/printers")
  },
  print: (printerName: string, html: string) =>
    req<{ ok: boolean }>("POST", "/print", { printerName, html })
};
