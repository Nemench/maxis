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
//
// This is the SINGLE authority for scan detection — there must be no
// second, independent Enter-triggered handler anywhere else (e.g. on the
// search input itself) racing against it. A previous version of this
// feature had exactly that: a global listener AND the search input's own
// onKeyDown both listening for Enter, and neither one suppressed the
// browser's default typing behavior — so the scanned digits always
// accumulated visibly in the input regardless of what the timing logic
// detected, and a single scan could trigger the lookup twice. `feedScanKey`
// now owns the full decision (suppress this keystroke? clear what already
// typed? is this Enter a completed scan?) so the DOM-level caller (see
// POSPanel) is a thin, single wrapper with nothing left to race against.
export interface ScanBufferState {
  buffer: string;
  lastTime: number;
  // True once 2+ fast keystrokes have confirmed "this is a scanner burst
  // in progress" — distinct from merely having a non-empty buffer, since
  // a single keystroke alone (the necessarily-unsuppressable first
  // character of any burst) isn't yet distinguishable from the start of
  // ordinary typing.
  bursting: boolean;
}

export const SCAN_MAX_GAP_MS = 50;
export const SCAN_MIN_LENGTH = 4;

export function initScanBuffer(): ScanBufferState {
  return { buffer: "", lastTime: 0, bursting: false };
}

export interface ScanKeyResult {
  // This keystroke should be suppressed (preventDefault'd) — it's been
  // confirmed as part of an in-progress scanner burst, so it must never
  // be allowed to type into whatever's focused.
  suppress: boolean;
  // Fires exactly once per burst: the moment enough fast keystrokes have
  // arrived to conclude "this is a scan, not typing." The burst's first
  // character can never be pre-emptively suppressed (there's no prior
  // keystroke to compare timing against), so the caller must retroactively
  // clear whatever that first, unsuppressed keystroke already typed.
  burstConfirmed: boolean;
  // Non-null exactly when this keystroke (always Enter) completes a scan
  // that was actually detected as a timing-based burst — never fires for
  // an Enter that follows ordinary typing, however long the typed text is.
  completedScan: string | null;
}

// Call once per keydown, mutating `state` in place (matches the
// imperative, per-event nature of a keydown listener). `key` is the raw
// KeyboardEvent.key value; `now` is the event timestamp in ms.
export function feedScanKey(state: ScanBufferState, key: string, now: number): ScanKeyResult {
  if (key === "Enter") {
    const completedScan = state.bursting && state.buffer.length >= SCAN_MIN_LENGTH ? state.buffer : null;
    const suppress = completedScan != null;
    state.buffer = "";
    state.bursting = false;
    return { suppress, burstConfirmed: false, completedScan };
  }
  if (key.length !== 1) return { suppress: false, burstConfirmed: false, completedScan: null }; // ignore Shift/Tab/Backspace/arrows/etc.

  const hadPriorChar = state.buffer.length > 0;
  const isFastContinuation = hadPriorChar && now - state.lastTime <= SCAN_MAX_GAP_MS;

  let burstConfirmed = false;
  if (isFastContinuation) {
    if (!state.bursting) { state.bursting = true; burstConfirmed = true; }
  } else {
    // Gap too long (or this is simply the first character) — whatever
    // was buffered wasn't a burst; start fresh from this keystroke.
    state.bursting = false;
    state.buffer = "";
  }

  state.buffer += key;
  state.lastTime = now;

  return { suppress: state.bursting, burstConfirmed, completedScan: null };
}
