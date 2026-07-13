import { useEffect, useRef, useState } from "react";

interface LogEntry {
  time: string;
  text: string;
}

function timestamp(): string {
  const d = new Date();
  return `${d.toLocaleTimeString("en-ZA", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// Bare, standalone diagnostic page — deliberately isolated from the real
// /pos screen (no auth, no product data, no other state/event handlers,
// no styling beyond basic readability) so the scanner-capture mechanism
// itself can be proven working on its own before being wired into
// anything real. Reached via window.location.pathname === "/dev/scan-test",
// checked in App() before any login/auth logic runs (see App.tsx) — the
// Express server's catch-all SPA fallback (server/index.ts) and Vite's
// dev server both serve index.html for this path already, no routing
// library or server changes needed.
//
// No timing/burst-speed heuristics anywhere here, deliberately — a
// hardware barcode scanner (USB or Bluetooth HID) just types its decoded
// digits into whatever currently has focus, indistinguishable from a
// human typist. Keeping a single input focused by default is the ENTIRE
// mechanism; there's nothing to guess from keystroke timing.
export function ScanTestPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const appendLog = (text: string) => {
    setLog((cur) => [{ time: timestamp(), text }, ...cur].slice(0, 300));
  };

  // Auto-focus on mount, and reclaim focus any time it's lost — there is
  // no other real input anywhere on this page to protect against, so
  // (unlike the real /pos screen) this can unconditionally refocus.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const refocus = () => inputRef.current?.focus();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    const added = next.length > value.length ? next.slice(value.length) : null;
    setValue(next);
    if (added) appendLog(`char received: "${added}"  (buffer now: "${next}")`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    appendLog(`ENTER — scan complete: "${value}"  (length ${value.length})`);
    setValue("");
  };

  return (
    <div style={{ fontFamily: "ui-monospace, monospace", padding: 24, maxWidth: 820, margin: "0 auto", color: "#eee", background: "#000", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20 }}>Scan capture test page</h1>
      <p>Standalone — no auth, no product lookup, no real styling. Point a scanner at any barcode and pull the trigger; no click needed anywhere on this page.</p>

      <p>Hidden input focused: <b style={{ color: focused ? "#0f0" : "#f55" }}>{String(focused)}</b></p>
      <p>Current buffer: <b>&quot;{value}&quot;</b></p>

      {/* The actual scanner target — invisible but still real/focusable. */}
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); window.setTimeout(refocus, 0); }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, padding: 0, border: "none", pointerEvents: "none" }}
        aria-hidden="true"
        tabIndex={-1}
      />

      <button type="button" onClick={() => setLog([])} style={{ margin: "12px 0", padding: "6px 14px" }}>Clear log</button>

      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 12, height: 440, overflowY: "auto", background: "#111", color: "#0f0", fontSize: 13, whiteSpace: "pre-wrap" }}>
        {log.length === 0 && <div style={{ color: "#888" }}>No events yet — scan a barcode.</div>}
        {log.map((entry, i) => (
          <div key={i}>[{entry.time}] {entry.text}</div>
        ))}
      </div>
    </div>
  );
}
