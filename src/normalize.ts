// Chrollo normalize — the adapter seam. Converts a raw JSONL line from any
// session store into a NormalizedRecord the core understands. v1 ships only the
// Pi adapter; future harnesses (Claude Code, Codex, …) add adapters here
// without touching the core (SPEC §3.6).
//
// This is where structural filtering happens (SPEC §3.4): type/role/block-type
// checks drop metadata, tool *outputs*, and thinking BEFORE ranking — the
// precision gain markdown fundamentally could not provide.

// A parsed message turn — the only kind search scores. `text` is the joined
// text blocks (the BM25 document and the one-liner preview); `toolCalls` is
// retained for readable rendering but excluded from search text.
export interface MessageRecord {
  kind: "message";
  source: string; // "pi" | future harness ids
  role: "user" | "assistant";
  text: string;
  toolCalls: { name: string; args: unknown }[];
  timestamp: number; // epoch ms
  lineKey: string; // "path:line" — round-trips straight into read's offset
}

// A compaction boundary — read annotates these as gaps; search ignores them.
export interface CompactionRecord {
  kind: "compaction";
  source: string;
  timestamp: number;
  lineKey: string;
}

// Parsed but irrelevant (session header, model_change, custom_message,
// toolResult, …). Read omits these; search ignores them.
export interface SkipRecord {
  kind: "skip";
  source: string;
  lineKey: string;
}

export type NormalizedRecord = MessageRecord | CompactionRecord | SkipRecord;

const PI_SESSION_MARK = "/.pi/agent/sessions/";

function isPiSessionPath(path: string): boolean {
  return path.includes(PI_SESSION_MARK);
}

// Parse an ISO timestamp string into epoch ms, or undefined if not parseable.
function ts(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

// Main entry. Dispatches by path prefix. Returns null only on unparseable JSON
// (the caller never crashes on a bad line). Parsed-but-irrelevant lines return
// a SkipRecord so callers can uniformly switch on .kind.
export function parseLine(path: string, line: number, raw: string): NormalizedRecord | null {
  if (isPiSessionPath(path)) return piParse(path, line, raw);
  // No known adapter — default to Pi's shape (v1 assumption). When a second
  // harness lands this branch gains an `else if`.
  return piParse(path, line, raw);
}

function piParse(path: string, line: number, raw: string): NormalizedRecord | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // unparseable — defensive, never crashes the caller
  }

  const source = "pi";
  const lineKey = `${path}:${line}`;

  if (obj === null || typeof obj !== "object") return { kind: "skip", source, lineKey };

  // Compaction boundary — read annotates, search ignores.
  if (obj.type === "compaction") {
    return { kind: "compaction", source, timestamp: ts(obj.timestamp) ?? 0, lineKey };
  }

  // Everything that is not a message is metadata/noise for our purposes:
  // session header, model_change, thinking_level_change, custom_message, …
  // (Chrollo's own injections, if any ever land in Pi sessions as
  // custom_message, are dropped here too — no self-pollution.)
  if (obj.type !== "message") {
    return { kind: "skip", source, lineKey };
  }

  const msg = obj.message;
  if (msg === undefined || msg === null) return { kind: "skip", source, lineKey };

  const role = msg.role;
  // Tool *outputs* are their own role — the user explicitly wants these gone.
  if (role !== "user" && role !== "assistant") {
    return { kind: "skip", source, lineKey };
  }

  const content: any[] = Array.isArray(msg.content) ? msg.content : [];
  const textBlocks: string[] = [];
  const toolCalls: { name: string; args: unknown }[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks.push(block.text);
    } else if (
      role === "assistant" &&
      block.type === "toolCall" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({ name: block.name, args: block.arguments });
    }
    // thinking blocks: deliberately skipped (internal reasoning, not memory)
  }

  return {
    kind: "message",
    source,
    role,
    text: textBlocks.join("\n"),
    toolCalls,
    timestamp: ts(obj.timestamp) ?? 0,
    lineKey,
  };
}

// File-level cwd extraction. Pi message lines do NOT carry cwd — it lives on
// the session header (verified). corpus.ts reads each file's header line and
// builds a path→cwd map so rank.ts can apply a cwd-boost. Pi-specific for now.
export function extractSessionCwd(raw: string): string | undefined {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object") return undefined;
  if (obj.type === "session" && typeof obj.cwd === "string") return obj.cwd;
  return undefined;
}
