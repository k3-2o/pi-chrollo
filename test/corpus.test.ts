import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defaultRoot } from "../src/corpus";

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
