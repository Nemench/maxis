# NemenchPos

Local web-based kitchen order ticket system for butcheries and delis.

Runs on your local network — any device with a browser can log in simultaneously.

## Roles

| Role | Can do |
|---|---|
| Admin | Everything: users, stock, settings/branding, reports, statistics, Weigh-In, CRM, backup/restore, plus all order/POS/queue actions below |
| Master Cashier | Create orders, view the queue, and one-button accept/complete a ticket (skips the normal New → Received → Ready → Done stepping) |
| Cashier | Create orders (including POS walk-in sales), view the queue |
| Kitchen | Kitchen department queue only — advance kitchen items through their statuses |
| Counter | Counter department queue only — advance counter items through their statuses |
| Stock Taker | Products/Stock and Weigh-In screens only (no orders, users, or settings) |

Default login after a fresh install: **Admin / 0000** — change the PIN immediately from Users after first login.

This "Admin" role is local to one shop's own NemenchPos instance. It's unrelated to the separate **master admin** control plane described near the bottom of this file, which oversees multiple independently-hosted shops at once.

---

## How NemenchPos works

Each shop runs its own **fully self-contained, offline-first** NemenchPos instance (Node/Express + SQLite) on its own network — nothing here depends on the internet to function day-to-day. The pieces:

- **Orders / Queue / History** — cashiers and counter/kitchen staff create tickets (KOT), which move through `New → Received → Ready → Done` per department (kitchen and counter are tracked separately, since a ticket can have items for both). History shows completed tickets for a configurable retention window.
- **POS** — a touch-friendly till for walk-in sales: product grid, live receipt preview, cash/card payment with change calculation, percentage discounts (behind a PIN-confirmation for any destructive action like removing a line or clearing the sale), and South African SARS tax-compliance rules baked in (VAT-inclusive pricing, and a full tax invoice — buyer name + address — is required and enforced server-side above R5,000 per sale). A POS sale completes and deducts stock immediately, unlike a regular KOT ticket which only deducts stock in Weigh-In/receiving flows.
- **Stock / Products** — the product catalog, with auto-generated EAN-13 barcodes, per-product cost price (required before a product can be sold, enforced server-side), and physical stock-count reconciliation across one or more stock locations.
- **Weigh-In** — logs raw carcass/organ intake by weight, batch by batch. Optionally records **cut-yield estimates** (e.g. how much boneless rump a side of beef is expected to yield) which land in an admin **review queue** — nothing touches actual stock until an admin approves and applies the estimate against real sub-products.
- **Statistics** — sales, stock movement, and profit-margin dashboards (revenue vs. cost per product/category/day), computed from cost prices snapshotted at time of sale.
- **CRM & WhatsApp automation** — an optional local customer-relationship layer (see `server/database.ts`'s `crm_*` tables and `server/whatsapp/`). POS checkout has an optional "Customer number" field (never required, never slows down a walk-in sale) that resolves or creates a contact. Order-ready and payment-received events can automatically queue a WhatsApp notification, gated on consent (`opted_in`/`opted_out`/`unknown`) and an admin-configured automation rule per event. Inbound WhatsApp messages and manual staff replies (from the admin CRM tab) are all logged to the same per-contact message history. Requires real Meta WhatsApp Cloud API credentials to actually send — see the `WHATSAPP_*` environment variables below.
- **Email order notifications** — a separate, independent notification channel (see `server/email/`) built on [Nodemailer](https://nodemailer.com/), an open-source SMTP library — not tied to the CRM/WhatsApp system above at all, no consent/contact model, just a plain optional "Customer email" field at checkout (POS or New Order). Set up entirely from **Settings → Email notifications** — no server access needed: pick your email provider (Gmail/Outlook/Yahoo/other), enter that account's address and password, save (PIN-confirmed, since it's effectively an email account login), then turn notifications on and write the subject/body for each event (`{{customerName}}`/`{{ticketNumber}}`/`{{amount}}` placeholders). The password is write-only — once saved it's never shown or sent back to the browser again, only whether one is set. `EMAIL_SMTP_*` environment variables (below) are also supported as a fallback for anyone who'd rather configure it that way instead.
- **Settings** — branding (site name, logo, theme color), printer assignments, VAT registration, email notification templates, and (native Android app only) the app's launcher icon.
- **Backup / Restore** — a full JSON export/import of the database, admin-only, done from the Settings screen.

---

## Option 1 — Install inside an existing LXC / server

Create a fresh **Debian 12 or Ubuntu 22.04** container or server, then run inside it:

```bash
curl -sSL https://raw.githubusercontent.com/Nemench/NemenchPos/main/install.sh | bash
```

The script installs Node.js 20, clones the repo, builds the app, and sets up a systemd service that starts automatically on boot.

Access the app at `http://<server-ip>:3000`

**Service commands:**
```bash
systemctl status nemenchpos
systemctl restart nemenchpos
journalctl -u nemenchpos -f    # live logs
```

**To update:**
```bash
bash /opt/nemenchpos/install.sh
```

---

## Option 2 — Docker Compose

```bash
git clone https://github.com/Nemench/NemenchPos.git
cd NemenchPos
docker compose up -d
```

Access at `http://localhost:3000`

Data is stored in a named Docker volume (`nemenchpos-data`) so it survives container rebuilds.

**To update:**
```bash
git pull
docker compose up -d --build
```

---

## Option 3 — Local development

Requires Node.js 20+.

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

---

## Option 4 — Windows desktop app (.exe installer)

Download the latest installer from the [Releases page](https://github.com/Nemench/NemenchPos/releases).

Double-click `NemenchPos-Setup.exe` to install. The app starts automatically and sits in the **system tray** — left-click the tray icon to open NemenchPos in your browser. Other devices on the same network can connect via `http://<this-pc-ip>:3000`.

> The installer is built automatically by GitHub Actions whenever a new version tag is pushed. No Windows machine needed to build it.

---

## Option 5 — Windows server (PowerShell installer)

Use this option when you want NemenchPos to run as a **background Windows service** (auto-starts on boot, no tray icon, accessible from the whole network) on a Windows 10 or 11 PC.

**Requirements:** Windows 10 21H2+ or Windows 11, PowerShell 5.1+, internet access.

Open **PowerShell as Administrator** and run:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://raw.githubusercontent.com/Nemench/NemenchPos/main/install.ps1 | iex
```

Or clone the repo first and run the script directly:

```powershell
git clone https://github.com/Nemench/NemenchPos.git C:\opt\nemenchpos
powershell -ExecutionPolicy Bypass -File C:\opt\nemenchpos\install.ps1
```

The script will:
1. Install **Node.js LTS** and **Git** via winget if not already present
2. Clone (or pull) the repo to `C:\opt\nemenchpos`
3. Run `npm ci` and `npm run build`
4. Download **NSSM** (Non-Sucking Service Manager) to `C:\nssm\`
5. Register NemenchPos as a Windows service that starts automatically on boot
6. Print the local IP and port when done

Access the app at `http://<this-pc-ip>:3000`

**Service commands:**
```powershell
C:\nssm\nssm.exe status  nemenchpos
C:\nssm\nssm.exe restart nemenchpos
C:\nssm\nssm.exe stop    nemenchpos
```

**Logs:** `C:\opt\nemenchpos\logs\`

**To update:**
```powershell
powershell -ExecutionPolicy Bypass -File C:\opt\nemenchpos\update.ps1
```

**Printing on Windows:**
Server-side printing writes the ticket HTML to a temp file and opens it in the default browser, which triggers `window.print()`. For this to work, the NemenchPos service must run under an **interactive user account** (not `LocalSystem`). After install, open `services.msc`, find **NemenchPos**, go to the **Log On** tab, and set it to log on as your Windows user account.

---

## Master admin / multi-tenant control plane (optional)

Everything above describes one shop's own NemenchPos instance, which works fully standalone forever with no internet connection required. Separately, if you're running NemenchPos for **several independently-hosted shops**, there's an optional companion service (its own repo, its own process, its own single-admin login — currently still named `maxis-control-plane` on GitHub, pending a rename) — that lets one person oversee all of them from one place: branding, license/subscription status, feature flags, and WhatsApp configuration per business.

This is **not** the same as a shop's local "Admin" role above. The control plane has exactly one login (the "master admin" — set via a required `ADMIN_PASSWORD` environment variable, no default/auto-generated password), and shop staff never see or interact with it directly.

**How it connects:** each NemenchPos instance polls the control plane every 15 minutes for its own business profile (`server/controlPlaneSync.ts`) using two environment variables:

```
NEMENCHPOS_CONTROL_PLANE_URL=https://your-control-plane-host
NEMENCHPOS_CONTROL_API_KEY=<per-business API key, generated in the control plane admin UI>
```

Leave both unset and a NemenchPos instance just runs standalone forever (the default, and a fully valid deployment mode) — nothing about POS, kitchen, or order flow ever depends on the control plane being reachable. A sync failure only ever falls back to the last-cached (or a safe default) profile; it never throws or blocks the shop's own server from starting or operating.

**What syncs down to each shop:**
- Branding (business name, logo, theme color) and VAT number
- License status (`trial` / `active` / `pending_suspension` / `suspended`) and a 30-day grace period once suspension is initiated — surfaced only to that shop's own local Admin, only outside the POS/Queue screens, as a dismissible banner (never something that blocks or degrades POS/kitchen operation)
- Feature flags (e.g. `inventory`, `whatsapp`, `multi_till`)
- `whatsapp_number_id` / `whatsapp_templates` — WhatsApp Cloud API configuration for that business's CRM automation (see above). The actual WhatsApp **access token** is deliberately *not* synced through the control plane (a real secret, kept local-only per shop) — see the `WHATSAPP_*` env vars below.

**Deploying the control plane itself:**
```bash
ADMIN_PASSWORD=yourpassword bash install.sh   # from the control-plane repo
```
Runs on port 3002 by default, admin UI at `/admin`. See that repo's own README for the full admin API (create/edit business, regenerate API key, view change history, license status changes).

### WhatsApp CRM environment variables (per shop, optional)

Set these on a shop's own NemenchPos instance (already wired into `install.sh`) to enable actually *sending* WhatsApp messages — without them, contacts/consent/message history still work locally, but every outbound send just fails harmlessly and retries:

```
WHATSAPP_ACCESS_TOKEN=<Meta System User token — real secret, local-only, never synced>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<a string you choose, must match Meta's webhook config>
WHATSAPP_APP_SECRET=<from Meta App Dashboard, for webhook signature verification>
```

### Email notification environment variables (per shop, optional — advanced/fallback only)

**Most people don't need this section** — email sending is configured entirely from **Settings → Email notifications** in the app itself (pick a provider, enter the account and password, save). These environment variables exist only as a fallback for anyone who'd rather set it up via the server instead of the UI (e.g. a scripted/containerized deployment); if both are set, the Settings-configured value wins. Without either, the outbox worker just fails every send attempt harmlessly and retries — order flow itself is never affected. Any normal business email account's SMTP details work, or point this at a self-hosted mail server if you'd rather not use a third party:

```
EMAIL_SMTP_HOST=<e.g. smtp.gmail.com, or your own mail server>
EMAIL_SMTP_PORT=<usually 587 (STARTTLS) or 465 (TLS); defaults to 587>
EMAIL_SMTP_USER=<the mailbox/account username to authenticate as>
EMAIL_SMTP_PASS=<its password or app-specific password — real secret, local-only>
EMAIL_FROM_ADDRESS=<the address customers see as the sender — most providers require this to match EMAIL_SMTP_USER's account/domain>
```

---

## Data

The SQLite database lives at `./data/nemenchpos.sqlite`. Back this file up regularly to keep your orders and products safe.
