// --- Chrollo Capture Layer ---

export function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      parts.push(block.text.trim());
    }
  }

  return parts.join("\n").trim();
}

export function formatToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  output: string[],
): void {
  switch (name) {
    case "bash": {
      const cmd = args?.command;
      if (typeof cmd === "string") {
        output.push(`<tool>$ ${cmd}</tool>`);
      }
      break;
    }
    case "read":
    case "read_memory":
    case "grep":
    case "find":
    case "ls": {
      const parts: string[] = [name];
      if (args) {
        for (const val of Object.values(args)) {
          if (typeof val === "string") {
            parts.push(val);
            break;
          }
        }
      }
      output.push(`<tool>${parts.join(" ")}</tool>`);
      break;
    }
    case "edit":
    case "write": {
      const path = args?.path ?? args?.file;
      if (typeof path === "string") {
        output.push(`<tool>${name} ${path}</tool>`);
      } else {
        output.push(`<tool>${name}</tool>`);
      }
      break;
    }
    default: {
      const firstArg = args ? Object.values(args).find((v) => typeof v === "string") : undefined;
      if (typeof firstArg === "string") {
        output.push(`<tool>${name} ${firstArg}</tool>`);
      } else {
        output.push(`<tool>${name}</tool>`);
      }
      break;
    }
  }
}
