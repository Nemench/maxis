import { describe, it, expect } from "vitest";
import { initScanBuffer, feedScanBuffer, SCAN_MIN_LENGTH } from "./scanBuffer";

// Feeds a string as a sequence of keydown events `gapMs` apart, then a
// final Enter, returning whatever feedScanBuffer returned for that Enter
// (the "did this look like a completed scan" verdict).
function typeString(str: string, gapMs: number): string | null {
  const state = initScanBuffer();
  let t = 0;
  for (const ch of str) {
    feedScanBuffer(state, ch, t);
    t += gapMs;
  }
  return feedScanBuffer(state, "Enter", t);
}

describe("feedScanBuffer", () => {
  it("recognizes a fast burst (real scanner timing) of a full EAN-13 as a completed scan", () => {
    // Real USB/Bluetooth HID scanners type each character only a few ms
    // apart — well under the 50ms threshold.
    expect(typeString("6001234567890", 8)).toBe("6001234567890");
  });

  it("does NOT treat slow, human-paced keystrokes of the same digits as a scan", () => {
    // 200ms between keystrokes is well beyond human fast-typing speed,
    // let alone scanner speed — each keystroke resets the buffer, so by
    // the time Enter arrives only the last character remains, which is
    // below SCAN_MIN_LENGTH.
    const result = typeString("6001234567890", 200);
    expect(result).toBeNull();
  });

  it("ignores non-character keys (Shift, Tab, arrows) without breaking a real scan burst", () => {
    const state = initScanBuffer();
    let t = 0;
    for (const ch of "600123") { feedScanBuffer(state, ch, t); t += 5; }
    feedScanBuffer(state, "Shift", t); t += 5; // modifier keydown fires mid-scan on some scanners
    for (const ch of "4567890") { feedScanBuffer(state, ch, t); t += 5; }
    expect(feedScanBuffer(state, "Enter", t)).toBe("6001234567890");
  });

  it("rejects a too-short fast burst even if the timing looks scanner-like", () => {
    expect(typeString("12", 5)).toBeNull();
    expect("12".length).toBeLessThan(SCAN_MIN_LENGTH);
  });

  it("resets cleanly after a completed scan — a second fast burst still works", () => {
    const state = initScanBuffer();
    let t = 0;
    for (const ch of "111222333") { feedScanBuffer(state, ch, t); t += 5; }
    expect(feedScanBuffer(state, "Enter", t)).toBe("111222333");
    t += 5;
    for (const ch of "444555666") { feedScanBuffer(state, ch, t); t += 5; }
    expect(feedScanBuffer(state, "Enter", t)).toBe("444555666");
  });

  it("a lone fast burst with no Enter never completes (still waiting)", () => {
    const state = initScanBuffer();
    let t = 0;
    for (const ch of "6001234567890") {
      const result = feedScanBuffer(state, ch, t);
      expect(result).toBeNull();
      t += 5;
    }
  });
});
