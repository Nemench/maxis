import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import type {
  CreateOrderInput,
  Order,
  OrderItem,
  OrderStatus,
  Product,
  ProductInput
} from "../../src/shared/types.js";

type SqlValue = string | number | null;

const ACTIVE_STATUSES: OrderStatus[] = ["New", "Prep", "Ready"];

export class KotDatabase {
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private dbPath = "";

  async initialize() {
    this.SQL = await initSqlJs({
      locateFile: (file: string) => this.resolveSqlAsset(file)
    });

    this.dbPath = path.join(app.getPath("userData"), "butcher-kot.sqlite");
    const data = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = data ? new this.SQL.Database(data) : new this.SQL.Database();
    this.migrate();
    this.seedProducts();
    this.save();
  }

  listProducts(): Product[] {
    return this.all<Product>(
      "select id, name, category, unitDefault, pricePerUnit, prepNotes, isActive, createdAt, updatedAt from products where isActive = 1 order by category, name"
    );
  }

  upsertProduct(input: ProductInput): Product {
    const now = new Date().toISOString();
    let productId: number;

    if (input.id) {
      this.run(
        "update products set name = ?, category = ?, unitDefault = ?, pricePerUnit = ?, prepNotes = ?, updatedAt = ? where id = ?",
        [input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), now, input.id]
      );
      productId = input.id;
    } else {
      this.run(
        "insert into products (name, category, unitDefault, pricePerUnit, prepNotes, isActive, createdAt, updatedAt) values (?, ?, ?, ?, ?, 1, ?, ?)",
        [input.name.trim(), input.category.trim(), input.unitDefault, input.pricePerUnit ?? null, input.prepNotes.trim(), now, now]
      );
      productId = Number(this.scalar("select last_insert_rowid()"));
    }

    this.save();
    return this.getProduct(productId);
  }

  deleteProduct(id: number) {
    this.run("update products set isActive = 0, updatedAt = ? where id = ?", [new Date().toISOString(), id]);
    this.save();
  }

  createOrder(input: CreateOrderInput): Order {
    const now = new Date().toISOString();
    const ticketNumber = this.nextTicketNumber();
    this.run(
      "insert into orders (ticketNumber, customerName, customerPhone, status, createdAt, updatedAt) values (?, ?, ?, 'New', ?, ?)",
      [ticketNumber, input.customerName.trim(), input.customerPhone.trim(), now, now]
    );
    const orderId = Number(this.scalar("select last_insert_rowid()"));

    input.items.forEach((item) => {
      this.run(
        "insert into order_items (orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal) values (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          orderId,
          item.productId ?? null,
          item.name.trim(),
          item.kg ?? null,
          item.quantity ?? null,
          item.notes.trim(),
          item.unitPrice ?? null,
          item.lineTotal ?? null
        ]
      );
    });

    this.save();
    return this.getOrder(orderId);
  }

  updateOrderStatus(id: number, status: OrderStatus): Order {
    this.run("update orders set status = ?, updatedAt = ? where id = ?", [status, new Date().toISOString(), id]);
    this.save();
    return this.getOrder(id);
  }

  listOrders(scope: "active" | "history" | "all"): Order[] {
    let orders: Order[];
    if (scope === "active") {
      orders = this.all<Order>(
        `select * from orders where status in (${ACTIVE_STATUSES.map(() => "?").join(",")}) order by createdAt asc`,
        ACTIVE_STATUSES
      );
    } else if (scope === "history") {
      orders = this.all<Order>("select * from orders where status = 'Done' order by updatedAt desc limit 200");
    } else {
      orders = this.all<Order>("select * from orders order by createdAt desc limit 300");
    }

    return orders.map((order) => ({ ...order, items: this.listOrderItems(order.id) }));
  }

  getOrder(id: number): Order {
    const order = this.one<Order>("select * from orders where id = ?", [id]);
    if (!order) {
      throw new Error(`Order ${id} not found`);
    }
    return { ...order, items: this.listOrderItems(id) };
  }

  private migrate() {
    this.run(`
      create table if not exists products (
        id integer primary key autoincrement,
        name text not null,
        category text not null default '',
        unitDefault text not null default 'kg',
        pricePerUnit real,
        prepNotes text not null default '',
        isActive integer not null default 1,
        createdAt text not null,
        updatedAt text not null
      )
    `);

    this.run(`
      create table if not exists orders (
        id integer primary key autoincrement,
        ticketNumber text not null unique,
        customerName text not null,
        customerPhone text not null,
        status text not null check (status in ('New', 'Prep', 'Ready', 'Done')),
        createdAt text not null,
        updatedAt text not null
      )
    `);

    this.run(`
      create table if not exists order_items (
        id integer primary key autoincrement,
        orderId integer not null references orders(id) on delete cascade,
        productId integer references products(id),
        name text not null,
        kg real,
        quantity integer,
        notes text not null default '',
        unitPrice real,
        lineTotal real
      )
    `);
  }

  private seedProducts() {
    const count = Number(this.scalar("select count(*) from products"));
    if (count > 0) return;

    const now = new Date().toISOString();
    [
      ["Beef Mince", "Beef", "kg", 0, "Pack fresh"],
      ["Rump Steak", "Beef", "kg", 0, "Cut to requested thickness"],
      ["Boerewors", "Sausage", "kg", 0, "Coil and pack"],
      ["Lamb Chops", "Lamb", "kg", 0, "Trim excess fat"],
      ["Chicken Fillets", "Poultry", "kg", 0, "Skinless"]
    ].forEach(([name, category, unitDefault, pricePerUnit, prepNotes]) => {
      this.run(
        "insert into products (name, category, unitDefault, pricePerUnit, prepNotes, isActive, createdAt, updatedAt) values (?, ?, ?, ?, ?, 1, ?, ?)",
        [name, category, unitDefault, Number(pricePerUnit), prepNotes, now, now]
      );
    });
  }

  private listOrderItems(orderId: number): OrderItem[] {
    return this.all<OrderItem>(
      "select id, orderId, productId, name, kg, quantity, notes, unitPrice, lineTotal from order_items where orderId = ? order by id asc",
      [orderId]
    );
  }

  private getProduct(id: number): Product {
    const product = this.one<Product>("select * from products where id = ?", [id]);
    if (!product) throw new Error(`Product ${id} not found`);
    return product;
  }

  private nextTicketNumber(): string {
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const prefix = `KOT-${stamp}-`;
    const current = this.scalar("select ticketNumber from orders where ticketNumber like ? order by id desc limit 1", [
      `${prefix}%`
    ]);
    const next = current ? Number(String(current).slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
  }

  private resolveSqlAsset(file: string) {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, file);
    }
    return path.join(process.cwd(), "node_modules", "sql.js", "dist", file);
  }

  private run(sql: string, params: SqlValue[] = []) {
    this.ensureDb().run(sql, params);
  }

  private scalar(sql: string, params: SqlValue[] = []): SqlValue {
    const result = this.ensureDb().exec(sql, params);
    return result[0]?.values[0]?.[0] ?? null;
  }

  private one<T>(sql: string, params: SqlValue[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  private all<T>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.ensureDb().prepare(sql, params);
    const rows: T[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject() as unknown as T);
    }
    statement.free();
    return rows;
  }

  private save() {
    const data = this.ensureDb().export();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("Database has not been initialized");
    }
    return this.db;
  }
}
