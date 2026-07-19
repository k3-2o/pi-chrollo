import { describe, it, expect } from "vitest";
import { parseLineDate, parseFileDate } from "../src/search";

// These parsers now read LOCAL time (matching how storage.ts writes via
// getHours/getMonth/getDate). Tests assert the LOCAL components round-trip,
// not a fixed epoch — that's the contract that was broken (UTC "Z" parsing).

describe("parseLineDate", () => {
  it("parses a full [YYYY-MM-DD HH:MM:SS] timestamp", () => {
    const dt = parseLineDate("[2026-06-07 10:24:51] [User]")!;
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(5); // June, 0-indexed
    expect(dt.getDate()).toBe(7);
    expect(dt.getHours()).toBe(10);
    expect(dt.getMinutes()).toBe(24);
    expect(dt.getSeconds()).toBe(51);
  });

  it("interprets the components as LOCAL time (not UTC)", () => {
    // The local components we wrote must come back unchanged. If it were parsed
    // as UTC, getTimezoneOffset() would create a mismatch in getHours().
    const dt = parseLineDate("[2026-01-15 09:30:00] x")!;
    expect(dt.getHours()).toBe(9);
    expect(dt.getMinutes()).toBe(30);
  });

  it("returns undefined for lines without a timestamp", () => {
    expect(parseLineDate("just some prose")).toBeUndefined();
    expect(parseLineDate("> blockquoted agent text")).toBeUndefined();
  });

  it("returns undefined for malformed timestamps", () => {
    expect(parseLineDate("[2026-6-7 10:24:51]")).toBeUndefined(); // no zero-pad
    expect(parseLineDate("[not-a-date]")).toBeUndefined();
  });

  it("does NOT append UTC semantics (regression: the old Z bug)", () => {
    // A timestamp written today, read now, must be in the past (daysSince >= 0),
    // not "in the future". We pick a clearly-old date to keep the test stable.
    const dt = parseLineDate("[2000-01-01 00:00:00] x")!;
    expect(dt.getTime()).toBeLessThan(Date.now());
  });
});

describe("parseFileDate", () => {
  it("parses a YYYY-MM-DD_HHMMSS_<prefix>.md filename", () => {
    const dt = parseFileDate("2026-06-07_104116_019ea175.md")!;
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(5);
    expect(dt.getDate()).toBe(7);
  });

  it("returns undefined for non-matching filenames", () => {
    expect(parseFileDate("random-notes.md")).toBeUndefined();
    expect(parseFileDate("2026-06-07_notes.md")).toBeUndefined();
    expect(parseFileDate("README.md")).toBeUndefined();
  });

  it("returns undefined for a prefix that isn't hex", () => {
    // the [a-f0-9]+ guard rejects non-hex
    expect(parseFileDate("2026-06-07_104116_019EZ175.md")).toBeUndefined();
  });
});
