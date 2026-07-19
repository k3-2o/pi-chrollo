import { describe, it, expect } from "vitest";
import { stem, groupWithStem, trigramRegex } from "../src/search";

// Phase 7: light stemming (AD-11) and trigram typo fallback (AD-12) — pure units.

describe("stem", () => {
  it("strips common suffixes to the root", () => {
    expect(stem("deployment")).toBe("deploy");
    expect(stem("running")).toBe("runn"); // strips 'ing' -> 'runn' (root>=3 guard keeps it)
    expect(stem("boxes")).toBe("box"); // wait: 'es' -> 'box' (3 chars, ok)
    expect(stem("configured")).toBe("configur"); // 'ed' stripped
    expect(stem("server")).toBe("serv"); // 'er' stripped
  });

  it("prefers the longest matching suffix (ment before s)", () => {
    expect(stem("management")).toBe("manage"); // 'ment', not 't'
  });

  it("leaves words <= 4 chars unchanged (too short to stem safely)", () => {
    expect(stem("run")).toBe("run");
    expect(stem("test")).toBe("test");
    expect(stem("api")).toBe("api");
  });

  it("over-stem guard: rejects a strip that would leave < 3 chars", () => {
    // 'using' (5) -> strip 'ing' -> 'us' (2 chars) -> rejected, keep original
    expect(stem("using")).toBe("using");
    // 'boxes' -> 'es' -> 'box' (3 chars) -> accepted
    expect(stem("boxes")).toBe("box");
  });

  it("returns the word unchanged when no suffix matches", () => {
    expect(stem("alpha")).toBe("alpha");
    expect(stem("docker")).toBe("dock"); // 'er' -> 'dock' (accepted, root 4)
    expect(stem("memory")).toBe("memory"); // ends 'y', no suffix
  });

  it("is idempotent-ish: stemming a stem rarely changes it further", () => {
    const s = stem("deployment"); // 'deploy'
    expect(stem(s)).toBe("deploy"); // 'deploy' has no suffix -> unchanged
  });
});

describe("groupWithStem", () => {
  it("returns [term, stem] when stemming changes the term", () => {
    expect(groupWithStem("deployment")).toEqual(["deployment", "deploy"]);
  });

  it("returns [term] when stemming does nothing", () => {
    expect(groupWithStem("alpha")).toEqual(["alpha"]);
    expect(groupWithStem("api")).toEqual(["api"]);
  });

  it("every entry is lowercase (matches tokenize output)", () => {
    // tokenize lowercases; stem operates on already-lowercased input, so this
    // is a contract check that callers can rely on.
    const g = groupWithStem("deployment");
    expect(g.every((x) => x === x.toLowerCase())).toBe(true);
  });
});

describe("trigramRegex", () => {
  it("builds a 3-char sliding-window alternation", () => {
    // 'receive' -> rec, ece, cei, eiv, ive
    expect(trigramRegex("receive")).toBe("(rec|ece|cei|eiv|ive)");
  });

  it("returns null for terms shorter than 4 chars", () => {
    expect(trigramRegex("abc")).toBeNull();
    expect(trigramRegex("ab")).toBeNull();
  });

  it("dedups repeated trigrams", () => {
    // 'anana' -> ana, nan, ana (deduped) -> ana, nan (2 unique)
    expect(trigramRegex("anana")).toBe("(ana|nan)");
  });

  it("returns null when fewer than 2 unique trigrams would result", () => {
    // 'aaaa' -> aaa, aaa -> 1 unique -> null
    expect(trigramRegex("aaaa")).toBeNull();
  });

  it("shares trigrams between a word and its common typo (the point)", () => {
    // 'receive' and 'recieve' share 'rec' and 'ive' -> a trigram search for
    // one matches the other.
    const receive = trigramRegex("receive")!;
    const recieve = trigramRegex("recieve")!;
    const shared = receive
      .replace(/[()]/g, "")
      .split("|")
      .filter((t) => recieve.includes(t));
    expect(shared.length).toBeGreaterThan(0); // at least one shared trigram
    expect(shared).toContain("rec");
  });
});
