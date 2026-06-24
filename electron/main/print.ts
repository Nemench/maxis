import { BrowserWindow } from "electron";
import type { Order } from "../../src/shared/types.js";
const appSettings = {
  currency: "ZAR",
  locale: "en-ZA"
} as const;

const escapeHtml = (value: string | number | null | undefined) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatNumber = (value: number | null | undefined) =>
  value === null || value === undefined || Number.isNaN(value) ? "" : new Intl.NumberFormat(appSettings.locale).format(value);

export function openPrintPreview(order: Order) {
  const preview = new BrowserWindow({
    width: 420,
    height: 760,
    title: `Print ${order.ticketNumber}`,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true
    }
  });

  preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderTicket(order))}`);
}

function renderTicket(order: Order) {
  const rows = order.items
    .map(
      (item) => `
        <tr>
          <td>
            <strong>${escapeHtml(item.name)}</strong>
            ${item.notes ? `<small>${escapeHtml(item.notes)}</small>` : ""}
          </td>
          <td>${item.kg ? `${formatNumber(item.kg)} kg` : ""}</td>
          <td>${item.quantity ? formatNumber(item.quantity) : ""}</td>
        </tr>
      `
    )
    .join("");

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(order.ticketNumber)}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #f5f1e8; color: #1d1b16; font-family: Arial, sans-serif; }
          .ticket { width: 80mm; min-height: 100vh; margin: 0 auto; background: #fff; padding: 14px; }
          header { border-bottom: 2px solid #1d1b16; padding-bottom: 10px; margin-bottom: 10px; }
          h1 { font-size: 22px; margin: 0; letter-spacing: 0; }
          .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 12px; margin-top: 8px; }
          .label { color: #675f50; text-transform: uppercase; font-size: 10px; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th { text-align: left; border-bottom: 1px solid #c9c0ae; padding: 6px 0; }
          td { border-bottom: 1px dashed #d8cfbd; padding: 8px 0; vertical-align: top; }
          td:nth-child(2), td:nth-child(3), th:nth-child(2), th:nth-child(3) { text-align: right; width: 48px; }
          small { display: block; color: #5f5748; margin-top: 3px; }
          .status { display: inline-block; margin-top: 10px; border: 1px solid #1d1b16; padding: 4px 8px; font-weight: 700; }
          .actions { display: flex; justify-content: center; gap: 8px; padding: 12px; }
          button { border: 0; background: #1f6f54; color: #fff; font-weight: 700; padding: 10px 14px; border-radius: 6px; cursor: pointer; }
          @media print {
            body { background: #fff; }
            .actions { display: none; }
            .ticket { width: auto; min-height: auto; padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="actions"><button onclick="window.print()">Print KOT</button></div>
        <main class="ticket">
          <header>
            <h1>${escapeHtml(order.ticketNumber)}</h1>
            <div class="meta">
              <div><div class="label">Customer</div>${escapeHtml(order.customerName)}</div>
              <div><div class="label">Phone</div>${escapeHtml(order.customerPhone)}</div>
              <div><div class="label">Created</div>${escapeHtml(new Date(order.createdAt).toLocaleString(appSettings.locale))}</div>
              <div><div class="label">Status</div>${escapeHtml(order.status)}</div>
            </div>
          </header>
          <table>
            <thead><tr><th>Item</th><th>Kg</th><th>Qty</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="status">${escapeHtml(order.status)}</div>
        </main>
      </body>
    </html>
  `;
}
