// --- Chrollo Storage Layer ---

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

// --- Constants ---

const GLOBAL_MEMORIES_DIR = path.join(os.homedir(), ".chrollo", "memories");

let activeMemoriesDir: string | undefined;

// --- Helpers ---

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

function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

// --- Resolve per-project memories dir (nearest .chrollo, else git root, else global) ---
export function resolveMemoriesDir(cwd: string): string {
  const envDir = process.env.CHROLLO_MEMORIES_DIR?.trim();
  if (envDir !== undefined && envDir !== "") {
    return path.resolve(envDir);
  }

  let dir = path.resolve(cwd);
  const gitRoot = findGitRoot(dir);

  while (true) {
    if (fs.existsSync(path.join(dir, ".chrollo"))) {
      return path.join(dir, ".chrollo", "memories");
    }

    if (gitRoot !== undefined && dir === gitRoot) {
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return GLOBAL_MEMORIES_DIR;
}

export function setActiveMemoriesDir(cwd: string): string {
  activeMemoriesDir = resolveMemoriesDir(cwd);
  return activeMemoriesDir;
}

function memoriesDir(): string {
  return activeMemoriesDir ?? GLOBAL_MEMORIES_DIR;
}

function sessionFilePath(sessionId: string, startDate: Date, dir: string): string {
  const date = formatDate(startDate);
  const time = formatTime(startDate);
  const prefix = sessionIdPrefix(sessionId);
  return path.join(dir, `${date}_${time}_${prefix}.md`);
}

function findSessionFileInDir(sessionId: string, dir: string): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  const prefix = sessionIdPrefix(sessionId);
  const files = fs.readdirSync(dir);

  for (const file of files) {
    if (file.endsWith(`_${prefix}.md`) && file.startsWith("20")) {
      return path.join(dir, file);
    }
  }

  return undefined;
}

// --- Public API ---

// --- Ensure the memory directory exists ---
export function initMemoryDir(): void {
  fs.mkdirSync(memoriesDir(), { recursive: true });
}

// --- Find an existing session file by session ID prefix ---
export function findSessionFile(sessionId: string): string | undefined {
  const dir = memoriesDir();
  const found = findSessionFileInDir(sessionId, dir);
  if (found !== undefined) {
    return found;
  }

  // --- fallback for sessions created before project-scoped storage ---
  if (dir !== GLOBAL_MEMORIES_DIR) {
    return findSessionFileInDir(sessionId, GLOBAL_MEMORIES_DIR);
  }

  return undefined;
}

// --- Create a new session file with YAML frontmatter ---
export function createSessionFile(frontmatter: SessionFrontmatter): string {
  initMemoryDir();

  const dir = memoriesDir();
  const startDate = new Date(frontmatter.startDate);
  const filePath = sessionFilePath(frontmatter.sessionId, startDate, dir);

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

// --- Append a conversation line ---
export function appendLine(filePath: string, line: ConversationLine): void {
  const time = formatTimestamp(line.timestamp);

  if (line.role === "Agent") {
    // --- blockquote so internal markdown doesn't clash ---
    const quoted = line.text
      .split("\n")
      .map((l) => (l.trim() === "" ? ">" : `> ${l}`))
      .join("\n");
    const formatted = `[${time}] [Agent]\n${quoted}\n`;
    fs.appendFileSync(filePath, formatted, "utf-8");
  } else {
    const formatted = `[${time}] [User]\n${line.text}\n`;
    fs.appendFileSync(filePath, formatted, "utf-8");
  }
}

// --- Append both user and agent messages for one turn ---
export function appendTurn(
  filePath: string,
  userText: string,
  agentText: string,
  timestamp: Date,
): void {
  appendLine(filePath, { role: "User", text: userText, timestamp });
  appendLine(filePath, { role: "Agent", text: agentText, timestamp: new Date() });
  // --- two blank lines between turns for readability ---
  fs.appendFileSync(filePath, "\n\n", "utf-8");
}

// --- Get the active memories directory path ---
export function getMemoriesDir(): string {
  return memoriesDir();
}

// --- Global memories dir (pre-project-scoped sessions) ---
export function getGlobalMemoriesDir(): string {
  return GLOBAL_MEMORIES_DIR;
}
