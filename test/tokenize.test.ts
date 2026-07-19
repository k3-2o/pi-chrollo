import { describe, it, expect } from "vitest";
import { tokenize } from "../src/search";

describe("tokenize", () => {
  it("splits camelCase identifiers", () => {
    expect(tokenize("getUserProfile")).toEqual(["get", "user", "profile"]);
  });

  it("splits PascalCase", () => {
    expect(tokenize("ParseResult")).toEqual(["parse", "result"]);
  });

  it("splits acronym + word (HTTPServer)", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits snake_case", () => {
    expect(tokenize("user_profile_id")).toEqual(["user", "profile"]);
    // "id" dropped by length>2 filter
  });

  it("splits kebab-case", () => {
    expect(tokenize("my-cool-tool")).toEqual(["cool", "tool"]);
    // "my" dropped by length>2 filter
  });

  it("preserves short distinctive tokens like k3s and url", () => {
    expect(tokenize("k3s url")).toEqual(["k3s", "url"]);
  });

  it("handles mixed identifiers and prose", () => {
    const out = tokenize("The optimizeRerenders function in user-service.ts");
    expect(out).toEqual(
      expect.arrayContaining(["optimize", "rerenders", "function", "user", "service"]),
    );
  });

  it("drops fragments of length <= 2", () => {
    // every token here is 1 or 2 chars -> all dropped (no 3-char words)
    expect(tokenize("a is to be x y z")).toEqual([]);
  });

  it("lowercases everything", () => {
    const out = tokenize("UPPERCASE MixedCase");
    expect(out.every((w) => w === w.toLowerCase())).toBe(true);
  });

  it("strips punctuation but keeps word characters", () => {
    expect(tokenize("hello, world! foo.bar(baz)")).toEqual(["hello", "world", "foo", "bar", "baz"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("does not split all-caps acronyms into single letters", () => {
    // HTTP alone stays one token (length 4); HTML stays one token (length 4)
    expect(tokenize("HTTP HTML API")).toEqual(["http", "html", "api"]);
  });
});
