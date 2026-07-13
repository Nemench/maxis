// Detects a hardware barcode-scanner "keyboard wedge" burst (USB or
// Bluetooth HID — both just type the decoded digits as fast, back-to-back
// keystrokes followed by Enter, indistinguishable from a very fast
// keyboard) vs ordinary human typing, purely from keystroke timing. A
// real scanner types each character within a handful of ms of the last;
// a human typing, even quickly, is far slower and more irregular.
// Framework-agnostic (no DOM/React dependency) so the detection logic
// itself can be driven by synthetic timestamps in a test rather than
// simulated real keyboard events, and reused by any screen that wants
// global scan capture (currently POSPanel).
export interface ScanBufferState {
  buffer: string;
  lastTime: number;
}

export const SCAN_MAX_GAP_MS = 50;
export const SCAN_MIN_LENGTH = 4;

export function initScanBuffer(): ScanBufferState {
  return { buffer: "", lastTime: 0 };
}

// Call once per keydown, mutating `state` in place (matches the
// imperative, per-event nature of a keydown listener). `key` is the raw
// KeyboardEvent.key value; `now` is the event timestamp in ms. Returns
// the completed scan string when this keystroke is an Enter that closes
// out a plausible fast-typed buffer, or null otherwise — including both
// "this wasn't a scan" (buffer too short/too slow) and "still mid-scan,
// wait for more keystrokes."
export function feedScanBuffer(state: ScanBufferState, key: string, now: number): string | null {
  if (key === "Enter") {
    const completed = state.buffer.length >= SCAN_MIN_LENGTH ? state.buffer : null;
    state.buffer = "";
    return completed;
  }
  if (key.length !== 1) return null; // ignore Shift/Tab/Backspace/arrows/etc.
  if (now - state.lastTime > SCAN_MAX_GAP_MS) state.buffer = ""; // gap too long — not part of the same burst
  state.buffer += key;
  state.lastTime = now;
  return null;
}
