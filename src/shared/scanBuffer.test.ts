import { describe, it, expect } from "vitest";
import { initScanBuffer, feedScanKey, SCAN_MIN_LENGTH } from "./scanBuffer";

describe("feedScanKey", () => {
  it("never suppresses the first keystroke of a burst (there's nothing to compare timing against yet)", () => {
    const state = initScanBuffer();
    const result = feedScanKey(state, "6", 0);
    expect(result.suppress).toBe(false);
    expect(result.burstConfirmed).toBe(false);
  });

  it("confirms the burst on the SECOND fast keystroke, and only that one", () => {
    const state = initScanBuffer();
    feedScanKey(state, "6", 0);
    const second = feedScanKey(state, "0", 8);
    expect(second.suppress).toBe(true);
    expect(second.burstConfirmed).toBe(true); // caller should now wipe the visible first char

    const third = feedScanKey(state, "0", 16);
    expect(third.suppress).toBe(true);
    expect(third.burstConfirmed).toBe(false); // already confirmed — don't fire the "clear it" signal twice
  });

  it("suppresses every character of a fast burst and completes the scan on Enter", () => {
    const state = initScanBuffer();
    const barcode = "6001234567890";
    let t = 0;
    for (const ch of barcode) {
      const r = feedScanKey(state, ch, t);
      if (t > 0) expect(r.suppress).toBe(true); // everything after the unavoidable first char
      t += 8;
    }
    const enterResult = feedScanKey(state, "Enter", t);
    expect(enterResult.completedScan).toBe(barcode);
    expect(enterResult.suppress).toBe(true); // Enter itself must be suppressed too (no stray form submit etc.)
  });

  it("never suppresses slow, human-paced keystrokes, and Enter after them is NOT treated as a completed scan", () => {
    const state = initScanBuffer();
    const digits = "6001234567890";
    let t = 0;
    for (const ch of digits) {
      const r = feedScanKey(state, ch, t);
      expect(r.suppress).toBe(false);
      t += 200; // well beyond scanner speed
    }
    const enterResult = feedScanKey(state, "Enter", t);
    expect(enterResult.completedScan).toBeNull();
    expect(enterResult.suppress).toBe(false); // ordinary Enter — don't interfere with it
  });

  it("a burst interrupted by a slow gap falls back to normal (unsuppressed) typing", () => {
    const state = initScanBuffer();
    feedScanKey(state, "6", 0);
    feedScanKey(state, "0", 8); // burst confirmed
    const interrupted = feedScanKey(state, "0", 300); // long pause — not scanner-like anymore
    expect(interrupted.suppress).toBe(false);
    expect(interrupted.burstConfirmed).toBe(false);
  });

  it("ignores non-character keys (Shift, Tab, arrows) without breaking a burst in progress", () => {
    const state = initScanBuffer();
    feedScanKey(state, "6", 0);
    feedScanKey(state, "0", 8); // bursting = true
    const modifier = feedScanKey(state, "Shift", 10);
    expect(modifier.suppress).toBe(false); // modifier keys are never suppressed
    const next = feedScanKey(state, "0", 16);
    expect(next.suppress).toBe(true); // burst state survived the ignored key
  });

  it("rejects a too-short fast burst even though the timing looked scanner-like", () => {
    const state = initScanBuffer();
    feedScanKey(state, "1", 0);
    feedScanKey(state, "2", 5);
    expect("12".length).toBeLessThan(SCAN_MIN_LENGTH);
    const enterResult = feedScanKey(state, "Enter", 10);
    expect(enterResult.completedScan).toBeNull();
  });

  it("resets cleanly after a completed scan — a second fast burst still works", () => {
    const state = initScanBuffer();
    let t = 0;
    for (const ch of "111222333") { feedScanKey(state, ch, t); t += 5; }
    expect(feedScanKey(state, "Enter", t).completedScan).toBe("111222333");
    t += 5;
    for (const ch of "444555666") { feedScanKey(state, ch, t); t += 5; }
    expect(feedScanKey(state, "Enter", t).completedScan).toBe("444555666");
  });
});
