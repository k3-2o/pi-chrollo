// --- Chrollo Stats Layer ---

import * as fs from "node:fs";
import * as path from "node:path";
import { getMemoriesDir } from "./storage.js";

export interface MemoryStats {
  sessionCount: number;
  totalLines: number;
}

export function getMemoryStats(): MemoryStats {
  const memoriesDir = getMemoriesDir();

  if (!fs.existsSync(memoriesDir)) {
    return { sessionCount: 0, totalLines: 0 };
  }

  const files = fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".md"));
  let totalLines = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(memoriesDir, file), "utf-8");
    // --- count [User] lines (old + new format)
    const matches = content.match(/^\[(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\] \[User\]/gm);
    totalLines += matches?.length ?? 0;
  }

  return { sessionCount: files.length, totalLines };
}
