import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setActiveMemoriesDir,
  createSessionFile,
  appendTurn,
  findSessionFile,
  type SessionFrontmatter,
} from "../src/storage";

// Phase 5: async storage round-trips (AD-8).

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-storage-"));
  setActiveMemoriesDir(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fm(overrides: Partial<SessionFrontmatter> = {}): SessionFrontmatter {
  return {
    sessionId: "019test01-0000-0000-0000-000000000001",
    startDate: "2026-06-01T10:00:00.000Z",
    harness: "pi",
    cwd: "/tmp/test",
    ...overrides,
  };
}

describe("createSessionFile (async)", () => {
  it("writes a file with valid YAML frontmatter", async () => {
    const p = await createSessionFile(fm());
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, "utf-8");

    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain('session_id: "019test01-0000-0000-0000-000000000001"');
    expect(content).toContain('harness: "pi"');
    expect(content).toContain('cwd: "/tmp/test"');
    expect(content).toMatch(/date: "\d{4}-\d{2}-\d{2}"/);
    // closes frontmatter; body starts empty (turns appended later)
    expect(content.trim().endsWith("---")).toBe(true);
  });

  it("includes parent_session only when provided and non-empty", async () => {
    const withParent = await createSessionFile(fm({ parentSession: "/path/to/parent" }));
    expect(fs.readFileSync(withParent, "utf-8")).toContain('parent_session: "/path/to/parent"');

    const without = await createSessionFile(fm());
    expect(fs.readFileSync(without, "utf-8")).not.toContain("parent_session");
  });

  it("creates the memories dir if it doesn't exist (initMemoryDir inside)", async () => {
    // fresh tmp with no .chrollo yet
    const p = await createSessionFile(fm());
    expect(fs.existsSync(p)).toBe(true);
  });

  it("derives the filename from startDate + sessionId prefix", async () => {
    const p = await createSessionFile(fm({ sessionId: "abcdef12-rest" }));
    expect(path.basename(p)).toMatch(/^2026-06-01_\d{6}_abcdef12\.md$/);
  });
});

describe("appendTurn (async)", () => {
  it("appends a user line then a blockquoted agent line + blank separator", async () => {
    const p = await createSessionFile(fm());
    await appendTurn(p, "hello world", "agent reply here", new Date("2026-06-01T10:05:00Z"));

    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("[User]\nhello world");
    expect(content).toContain("[Agent]");
    // agent text is blockquoted
    expect(content).toContain("> agent reply here");
    // two blank lines between turns (the trailing \n\n)
    expect(content).toMatch(/\n\n$/);
  });

  it("blockquotes multi-line agent text line by line", async () => {
    const p = await createSessionFile(fm());
    await appendTurn(p, "q", "line one\nline two\n\nline four", new Date());
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("> line one");
    expect(content).toContain("> line two");
    expect(content).toContain("> line four");
  });

  it("does not blockquote the user message", async () => {
    const p = await createSessionFile(fm());
    await appendTurn(p, "user says this", "agent", new Date());
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("[User]\nuser says this");
    expect(content).not.toContain("> user says this");
  });

  it("survives multiple consecutive turns (append-only growth)", async () => {
    const p = await createSessionFile(fm());
    await appendTurn(p, "turn1", "a1", new Date());
    await appendTurn(p, "turn2", "a2", new Date());
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("turn1");
    expect(content).toContain("turn2");
    // 2 user turns
    expect(content.match(/\[User\]/g)).toHaveLength(2);
  });
});

describe("findSessionFile (async)", () => {
  it("finds a session file by id prefix after creation", async () => {
    const created = await createSessionFile(fm({ sessionId: "deadbeef-1234" }));
    const found = await findSessionFile("deadbeef-1234-5678");
    expect(found).toBe(created);
  });

  it("returns undefined when no file matches the prefix", async () => {
    await createSessionFile(fm({ sessionId: "deadbeef-1234" }));
    const found = await findSessionFile("ffffffff-9999");
    expect(found).toBeUndefined();
  });
});
