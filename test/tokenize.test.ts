import { describe, it, expect } from "vitest";
import { tokenize, queryTerms, STOP_WORDS } from "../src/tokenize";

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

describe("queryTerms", () => {
  it("returns nothing for a query of only stopwords/short tokens", () => {
    expect(queryTerms("the a an")).toEqual([]);
  });

  it("returns content words (stopwords dropped)", () => {
    expect(queryTerms("docker compose port")).toEqual(["docker", "compose", "port"]);
  });

  it("does not filter by corpus rarity (no dictionary — SPEC §3.3)", () => {
    // 'config' would have been filtered as too-common under the old rarity
    // filter. Now it's kept — the user typed it, it stays.
    expect(queryTerms("fix config docker")).toEqual(["fix", "config", "docker"]);
  });

  it("preserves input order (no rarity reordering)", () => {
    expect(queryTerms("alpha beta gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("caps at 8 terms", () => {
    const terms = queryTerms("alpha beta gamma delta epsilon zeta eta theta iota");
    expect(terms.length).toBeLessThanOrEqual(8);
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
