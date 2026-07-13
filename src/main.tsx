import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { ScanTestPage } from "./ui/ScanTestPage";
import "./ui/styles.css";

// Bare, unauthenticated diagnostic page for proving the barcode-scanner
// capture mechanism works in isolation before it's wired into anything
// real — see ScanTestPage's own comment. Decided here, before <App>
// mounts at all, rather than as a branch inside App() itself: this app
// has no client-side router, so this is the one place a path-based
// choice like this belongs, and keeps the diagnostic page from ever
// sharing a component (and thus hooks/state) with the real app.
const Root = window.location.pathname === "/dev/scan-test" ? ScanTestPage : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
