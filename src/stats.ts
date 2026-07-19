// --- Chrollo Stats Layer ---

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getMemoriesDir } from "./storage.js";

export interface MemoryStats {
  sessionCount: number;
  totalLines: number;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const memoriesDir = getMemoriesDir();

  if (!fs.existsSync(memoriesDir)) {
    return { sessionCount: 0, totalLines: 0 };
  }

  const files = (await fsp.readdir(memoriesDir)).filter((f) => f.endsWith(".md"));
  let totalLines = 0;

  // Read all files in parallel — was a blocking readFileSync loop.
  const contents = await Promise.all(
    files.map((f) => fsp.readFile(path.join(memoriesDir, f), "utf-8")),
  );
  for (const content of contents) {
    // --- count [User] lines (old + new format)
    const matches = content.match(/^\[(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\] \[User\]/gm);
    totalLines += matches?.length ?? 0;
  }

  return { sessionCount: files.length, totalLines };
}
