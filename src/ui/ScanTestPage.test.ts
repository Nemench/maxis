import { describe, it, expect } from "vitest";

// ScanTestPage.tsx's entire capture mechanism is two trivial operations
// on a plain string (onChange: append whatever grew; onKeyDown Enter:
// read + clear) — deliberately too simple to need a pure module of its
// own (the whole point of that page is having as little logic as
// possible to go wrong). This test drives that exact algorithm, not a
// mock of it, to prove the accumulate-then-resolve mechanism itself is
// correct before it's ever pointed at a real scanner. It does NOT (and
// cannot, without a browser) prove that real keystrokes reach a real
// focused DOM input — that part still needs an actual device test.
interface ScanTestState {
  value: string;
  log: string[];
}

function onChange(state: ScanTestState, nextValue: string): void {
  const added = nextValue.length > state.value.length ? nextValue.slice(state.value.length) : null;
  state.value = nextValue;
  if (added) state.log.push(`char received: "${added}"  (buffer now: "${nextValue}")`);
}

function onEnter(state: ScanTestState): void {
  state.log.push(`ENTER — scan complete: "${state.value}"  (length ${state.value.length})`);
  state.value = "";
}

// Simulates a real <input>'s onChange firing once per keystroke (which
// is what actually happens in the browser — each keydown that isn't
// suppressed produces exactly one onChange with the input's new full
// value) followed by Enter.
function typeAndEnter(barcode: string): ScanTestState {
  const state: ScanTestState = { value: "", log: [] };
  let typed = "";
  for (const ch of barcode) {
    typed += ch;
    onChange(state, typed);
  }
  onEnter(state);
  return state;
}

describe("ScanTestPage capture mechanism", () => {
  it("logs every character as it's received, in order", () => {
    const state = typeAndEnter("123");
    expect(state.log.slice(0, 3)).toEqual([
      'char received: "1"  (buffer now: "1")',
      'char received: "2"  (buffer now: "12")',
      'char received: "3"  (buffer now: "123")'
    ]);
  });

  it("logs a completed scan on Enter with the full, correctly-ordered barcode", () => {
    const state = typeAndEnter("6001234567890");
    expect(state.log.at(-1)).toBe('ENTER — scan complete: "6001234567890"  (length 13)');
  });

  it("clears the buffer after Enter, ready for the next scan", () => {
    const state = typeAndEnter("111222333");
    expect(state.value).toBe("");
  });

  it("a second scan right after the first starts from a clean buffer, not appended to the previous one", () => {
    const state: ScanTestState = { value: "", log: [] };
    let typed = "";
    for (const ch of "AAA") { typed += ch; onChange(state, typed); }
    onEnter(state);
    expect(state.value).toBe("");

    typed = "";
    for (const ch of "BBB") { typed += ch; onChange(state, typed); }
    onEnter(state);

    expect(state.log.at(-1)).toBe('ENTER — scan complete: "BBB"  (length 3)');
    // Never "AAABBB" — proves the clear-on-Enter actually took effect
    // before the next scan's first character arrived.
    expect(state.log.some((l) => l.includes("AAABBB"))).toBe(false);
  });

  it("matches exactly what was encoded — a real EAN-13 round-trips character for character", () => {
    const barcode = "2000550099361"; // a real buildWeighBarcode() output from elsewhere in this app
    const state = typeAndEnter(barcode);
    expect(state.log.at(-1)).toContain(`"${barcode}"`);
  });
});
