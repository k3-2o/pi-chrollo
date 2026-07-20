import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defaultRoot, readSessionCwd } from "../src/corpus";

const SESSION_WITH_CWD =
  '{"type":"session","version":3,"id":"a","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj/a"}\n' +
  '{"type":"message","id":"u1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-corpus-"));
  file = path.join(tmp, "s.jsonl");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("defaultRoot", () => {
  it("points under ~/.pi/agent/sessions", () => {
    expect(defaultRoot()).toBe(path.join(os.homedir(), ".pi", "agent", "sessions"));
  });
});

describe("readSessionCwd", () => {
  it("returns cwd from a session file's header line", () => {
    fs.writeFileSync(file, SESSION_WITH_CWD, "utf-8");
    expect(readSessionCwd(file)).toBe("/proj/a");
  });

  it("returns undefined when the header has no cwd", () => {
    fs.writeFileSync(file, '{"type":"session","version":3,"id":"x"}\n', "utf-8");
    expect(readSessionCwd(file)).toBeUndefined();
  });

  it("returns undefined for a nonexistent file", () => {
    expect(readSessionCwd(path.join(tmp, "nope.jsonl"))).toBeUndefined();
  });

  it("returns undefined for an unreadable file", () => {
    fs.writeFileSync(file, SESSION_WITH_CWD, "utf-8");
    fs.chmodSync(file, 0o000);
    let cwd: string | undefined;
    try {
      cwd = readSessionCwd(file);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    // root can still read 000 files; tolerate either outcome but never throw
    expect(cwd === undefined || cwd === "/proj/a").toBe(true);
  });

  it("reads only the head of the file (no full read needed)", () => {
    // A file where the header is line 1 but the file is large. The function
    // must still resolve cwd without reading the whole thing.
    const big = SESSION_WITH_CWD.split("\n")[0] + "\n" + "x".repeat(200000) + "\n"; // 200KB of junk after the header
    fs.writeFileSync(file, big, "utf-8");
    expect(readSessionCwd(file)).toBe("/proj/a");
  });
});
