import { describe, it, expect } from "vitest";
import {
  tokenize,
  stem,
  groupWithStem,
  trigramRegex,
  extractDistinctiveTerms,
  STOP_WORDS,
} from "../src/tokenize";

describe("tokenize", () => {
  it("splits camelCase identifiers", () => {
    expect(tokenize("getUserProfile")).toEqual(["get", "user", "profile"]);
  });

  it("splits acronyms from camelCase (HTTPServer)", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits snake_case", () => {
    expect(tokenize("user_profile_data")).toEqual(["user", "profile", "data"]);
  });

  it("splits kebab-case", () => {
    expect(tokenize("api-gateway")).toEqual(["api", "gateway"]);
  });

  it("strips punctuation", () => {
    expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
  });

  it("drops fragments ≤ 2 chars", () => {
    expect(tokenize("a hi ok go")).toEqual([]);
  });

  it("lowercases everything", () => {
    const toks = tokenize("DOCKER Compose");
    expect(toks.every((t) => t === t.toLowerCase())).toBe(true);
    expect(toks).toEqual(["docker", "compose"]);
  });

  it("handles a realistic mixed query", () => {
    expect(tokenize("fix the docker-compose port mapping")).toEqual([
      "fix",
      "the",
      "docker",
      "compose",
      "port",
      "mapping",
    ]);
  });
});

describe("stem", () => {
  it("strips -ment suffix", () => {
    expect(stem("deployment")).toBe("deploy");
  });

  it("strips -ing suffix", () => {
    // light stemming has no double-consonant handling -> runn, not run
    expect(stem("running")).toBe("runn");
  });

  it("strips -ed suffix", () => {
    expect(stem("deployed")).toBe("deploy");
  });

  it("strips -er suffix (may over-match)", () => {
    // documented over-match: docker -> dock (mitigated downstream by rarity)
    expect(stem("docker")).toBe("dock");
  });

  it("leaves words with no matching suffix alone", () => {
    expect(stem("config")).toBe("config");
  });

  it("refuses to stem words ≤ 4 chars (over-stem guard)", () => {
    expect(stem("cats")).toBe("cats");
    expect(stem("run")).toBe("run");
  });

  it("keeps the original when the root would be < 3 chars", () => {
    // "doing" ends with -ing, root "do" (len 2) -> too short, keep original
    expect(stem("doing")).toBe("doing");
  });
});

describe("groupWithStem", () => {
  it("returns term + stem when stemming changes it", () => {
    expect(groupWithStem("deployment")).toEqual(["deployment", "deploy"]);
  });

  it("returns just the term when stemming doesn't change it", () => {
    expect(groupWithStem("config")).toEqual(["config"]);
  });
});

describe("trigramRegex", () => {
  it("builds an OR of 3-char trigrams", () => {
    // receive -> rec, ece, cei, eiv, ive
    expect(trigramRegex("receive")).toBe("(rec|ece|cei|eiv|ive)");
  });

  it("returns null for terms shorter than 4 chars", () => {
    expect(trigramRegex("cat")).toBeNull();
    expect(trigramRegex("ab")).toBeNull();
  });

  it("dedups trigrams", () => {
    // aaaa -> aaa, aaa -> dedup to one -> fewer than 2 -> null
    expect(trigramRegex("aaaa")).toBeNull();
  });

  it("requires at least 2 distinct trigrams", () => {
    // aaa -> only one trigram "aaa" -> null
    expect(trigramRegex("aaa")).toBeNull();
  });
});

describe("extractDistinctiveTerms", () => {
  it("returns nothing for a query of only stopwords/short tokens", () => {
    expect(extractDistinctiveTerms("the a an", new Map(), 100)).toEqual([]);
  });

  it("returns raw terms as fallback when corpus is empty", () => {
    const terms = extractDistinctiveTerms("docker compose port", new Map(), 0);
    expect(terms).toEqual(["docker", "compose", "port"]);
  });

  it("filters out terms appearing in ≥ 30% of documents", () => {
    // 'config' appears in 40/100 docs (40%), 'docker' in 5/100 (5%)
    const freq = new Map<string, number>([
      ["config", 40],
      ["docker", 5],
    ]);
    const terms = extractDistinctiveTerms("fix config docker", freq, 100);
    expect(terms).toContain("docker");
    expect(terms).not.toContain("config");
  });

  it("orders least-frequent terms first", () => {
    const freq = new Map<string, number>([
      ["alpha", 20],
      ["beta", 2],
      ["gamma", 10],
    ]);
    const terms = extractDistinctiveTerms("alpha beta gamma", freq, 100);
    expect(terms.indexOf("beta")).toBeLessThan(terms.indexOf("gamma"));
    expect(terms.indexOf("gamma")).toBeLessThan(terms.indexOf("alpha"));
  });

  it("caps at 5 terms", () => {
    const terms = extractDistinctiveTerms("alpha beta gamma delta epsilon zeta eta", new Map(), 0);
    expect(terms.length).toBeLessThanOrEqual(5);
  });
});

describe("STOP_WORDS", () => {
  it("contains common English stopwords", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("is")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
  });

  it("does NOT contain signal-bearing words", () => {
    expect(STOP_WORDS.has("remember")).toBe(false);
    expect(STOP_WORDS.has("docker")).toBe(false);
    expect(STOP_WORDS.has("config")).toBe(false);
  });
});
