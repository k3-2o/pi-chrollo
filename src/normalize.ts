// Chrollo normalize — parse a raw JSONL line from Pi's session store into a
// NormalizedRecord. This is where structural filtering happens: type/role/block
// checks drop metadata, tool *outputs*, and thinking BEFORE search formatting or
// read rendering.
//
// Only the Pi shape is handled — no speculative "adapter seam" for future
// harnesses (add one if a second harness actually lands).

// A parsed message turn — the only kind search scores and read renders.
export interface MessageRecord {
  kind: "message";
  source: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: { name: string; args: unknown }[];
  timestamp: number; // epoch ms
  lineKey: string; // "path:line" — round-trips into read's offset
}

// A compaction boundary — read annotates as gaps; search ignores.
export interface CompactionRecord {
  kind: "compaction";
  source: string;
  timestamp: number;
  lineKey: string;
}

// Parsed but irrelevant (session header, model_change, toolResult, ...).
export interface SkipRecord {
  kind: "skip";
  source: string;
  lineKey: string;
}

export type NormalizedRecord = MessageRecord | CompactionRecord | SkipRecord;

function ts(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

// Parse one raw JSONL line. Returns null only on unparseable JSON (caller never
// crashes on a bad line). Irrelevant lines return a SkipRecord so callers
// switch uniformly on .kind.
export function parseLine(path: string, line: number, raw: string): NormalizedRecord | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const source = "pi";
  const lineKey = `${path}:${line}`;

  if (obj === null || typeof obj !== "object") return { kind: "skip", source, lineKey };

  if (obj.type === "compaction") {
    return { kind: "compaction", source, timestamp: ts(obj.timestamp) ?? 0, lineKey };
  }

  // Everything that is not a message is metadata/noise: session header,
  // model_change, thinking_level_change, custom_message, tool_result, ...
  if (obj.type !== "message") return { kind: "skip", source, lineKey };

  const msg = obj.message;
  if (msg === undefined || msg === null) return { kind: "skip", source, lineKey };

  const role = msg.role;
  // Tool *outputs* are their own role — the user wants these gone.
  if (role !== "user" && role !== "assistant") return { kind: "skip", source, lineKey };

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
    // thinking blocks skipped (internal reasoning, not memory)
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
