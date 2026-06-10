/**
 * Chrollo Storage Layer
 *
 * Responsible for creating session files and appending conversation lines.
 * One markdown file per Pi session. Append-only. Verbatim.
 *
 * Core axiom: never decide what's important at write time.
 * Store everything. Let retrieval figure out relevance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionFrontmatter {
  sessionId: string;
  startDate: string;
  harness: string;
  cwd: string;
  parentSession?: string;
}

export interface ConversationLine {
  role: "User" | "Agent";
  text: string;
  timestamp: Date;
}

export interface MemoryStats {
  sessionCount: number;
  totalLines: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROLLO_DIR = path.join(os.homedir(), ".chrollo");
const MEMORIES_DIR = path.join(CHROLLO_DIR, "memories");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${m}:${s}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

function sessionIdPrefix(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function sessionFilePath(sessionId: string, startDate: Date): string {
  const date = formatDate(startDate);
  const time = formatTime(startDate);
  const prefix = sessionIdPrefix(sessionId);
  return path.join(MEMORIES_DIR, `${date}_${time}_${prefix}.md`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the memory directory exists. Call once at extension load.
 */
export function initMemoryDir(): void {
  fs.mkdirSync(MEMORIES_DIR, { recursive: true });
}

/**
 * Find an existing session file by scanning for its session ID prefix in filenames.
 * Returns the full path if found, undefined otherwise.
 */
export function findSessionFile(sessionId: string): string | undefined {
  if (!fs.existsSync(MEMORIES_DIR)) {
    return undefined;
  }

  const prefix = sessionIdPrefix(sessionId);
  const files = fs.readdirSync(MEMORIES_DIR);

  for (const file of files) {
    if (file.endsWith(`_${prefix}.md`) && file.startsWith("20")) {
      return path.join(MEMORIES_DIR, file);
    }
  }

  return undefined;
}

/**
 * Create a new session file with YAML frontmatter.
 * Returns the file path.
 */
export function createSessionFile(frontmatter: SessionFrontmatter): string {
  initMemoryDir();

  const startDate = new Date(frontmatter.startDate);
  const filePath = sessionFilePath(frontmatter.sessionId, startDate);

  const lines: string[] = [
    "---",
    `session_id: "${frontmatter.sessionId}"`,
    `date: "${formatDate(startDate)}"`,
    `harness: "${frontmatter.harness}"`,
    `cwd: "${frontmatter.cwd}"`,
  ];

  if (frontmatter.parentSession !== undefined && frontmatter.parentSession !== "") {
    lines.push(`parent_session: "${frontmatter.parentSession}"`);
  }

  lines.push("---", "");

  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

/**
 * Append a conversation line to a session file.
 *
 * Format:
 *   User → plain line: [HH:MM:SS] [User] text
 *   Agent → blockquoted:  [HH:MM:SS] [Agent]\n> line1\n> line2
 *
 * This is the hot path — must be fast. Just fs.appendFileSync.
 */
export function appendLine(filePath: string, line: ConversationLine): void {
  const time = formatTimestamp(line.timestamp);

  if (line.role === "Agent") {
    // Blockquote entire agent response so internal markdown doesn't clash
    const quoted = line.text
      .split("\n")
      .map((l) => (l.trim() === "" ? ">" : `> ${l}`))
      .join("\n");
    const formatted = `[${time}] [Agent]\n${quoted}\n`;
    fs.appendFileSync(filePath, formatted, "utf-8");
  } else {
    // User text is plain
    const text = line.text.replace(/\n/g, "\n  ");
    const formatted = `[${time}] [User] ${text}\n`;
    fs.appendFileSync(filePath, formatted, "utf-8");
  }
}

/**
 * Append both user and assistant messages for a single turn.
 * Adds two blank lines between turns for readability.
 */
export function appendTurn(
  filePath: string,
  userText: string,
  agentText: string,
  timestamp: Date,
): void {
  appendLine(filePath, { role: "User", text: userText, timestamp });
  appendLine(filePath, { role: "Agent", text: agentText, timestamp: new Date() });
  // Two blank lines between turns so the file is readable even unrendered
  fs.appendFileSync(filePath, "\n\n", "utf-8");
}

/**
 * Get memory statistics: session count and total conversation turns.
 */
export function getMemoryStats(): MemoryStats {
  if (!fs.existsSync(MEMORIES_DIR)) {
    return { sessionCount: 0, totalLines: 0 };
  }

  const files = fs.readdirSync(MEMORIES_DIR).filter((f) => f.endsWith(".md"));
  let totalLines = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(MEMORIES_DIR, file), "utf-8");
    // Count [User] lines — both old format [HH:MM:SS] and new format [YYYY-MM-DD HH:MM:SS]
    const matches = content.match(/^\[(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\] \[User\]/gm);
    totalLines += matches?.length ?? 0;
  }

  return { sessionCount: files.length, totalLines };
}

/**
 * Get the memories directory path. Useful for grep operations.
 */
export function getMemoriesDir(): string {
  return MEMORIES_DIR;
}
