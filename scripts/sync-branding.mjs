#!/usr/bin/env node
// Regenerates the Android app's icon source (assets/icon.png) and name
// (capacitor.config.ts + android strings.xml) from whatever the admin has
// currently configured in Settings — so the native app's branding can be
// kept in sync with the live site's logo/site name.
//
// This can't be automatic: Android compiles the launcher icon and app label
// into the APK at build time. A running app has no way to fetch a new icon
// or name for itself the way the in-app header/title do — that's an Android
// platform constraint, not something client code can work around. Run this
// script whenever the site's logo or name changes, then:
//   npm run android:assets   (regenerates all Android icon/splash densities)
//   npm run cap:sync         (copies everything into the native project)
// ...then rebuild the signed APK in Android Studio.
//
// Reads directly from the server's SQLite database and uploaded logo file,
// so it needs to point at the same DATA_DIR the production server uses
// (defaults to ./data, matching server/database.ts and server/index.ts).

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? path.join(root, "data");
const dbPath = path.join(dataDir, "maxis.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}.`);
  console.error(`Set DATA_DIR to the same data directory the production server runs with, e.g.:`);
  console.error(`  DATA_DIR=/path/to/data npm run branding:sync`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const getSetting = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;

const siteName = getSetting("siteName") || "MAXIS";
const logoUrl = getSetting("logoUrl") || "";

// An uploaded logo lives at DATA_DIR/uploads/logo.*; with none uploaded,
// fall back to the same default the site itself falls back to.
const logoPath = logoUrl
  ? path.join(dataDir, logoUrl.replace(/^\/+/, ""))
  : path.join(root, "public/logo.jpg");

if (!fs.existsSync(logoPath)) {
  console.error(`Logo file not found at ${logoPath}.`);
  process.exit(1);
}

// ── App name ─────────────────────────────────────────────────────────────
const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const capConfigPath = path.join(root, "capacitor.config.ts");
const capConfig = fs.readFileSync(capConfigPath, "utf8")
  .replace(/appName: '[^']*'/, `appName: '${siteName.replace(/'/g, "\\'")}'`);
fs.writeFileSync(capConfigPath, capConfig);

const stringsPath = path.join(root, "android/app/src/main/res/values/strings.xml");
const strings = fs.readFileSync(stringsPath, "utf8")
  .replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${escXml(siteName)}</string>`)
  .replace(/<string name="title_activity_main">[^<]*<\/string>/, `<string name="title_activity_main">${escXml(siteName)}</string>`);
fs.writeFileSync(stringsPath, strings);

// ── App icon ─────────────────────────────────────────────────────────────
// Pad the logo onto a square canvas rather than assuming any particular
// crop — an admin-uploaded logo could be any shape or composition, unlike
// the one-off manual crop used for the default emblem.
const iconOut = path.join(root, "assets/icon.png");
const emblem = await sharp(logoPath).resize(700, 700, { fit: "contain", background: "#ffffff" }).toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
  .composite([{ input: emblem, gravity: "center" }])
  .png()
  .toFile(iconOut);

console.log("Synced Android branding from live settings:");
console.log(`  App name:    "${siteName}"`);
console.log(`  Logo source: ${logoPath}`);
console.log("");
console.log("Next: npm run android:assets && npm run cap:sync, then rebuild the signed APK in Android Studio.");
