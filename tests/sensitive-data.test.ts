import { describe, expect, it } from "vitest";
import { MemorySensitiveDataPolicy } from "../src/adapters/index.js";

describe("known secret sanitization", () => {
  it("redacts literal and JSON-escaped text without keeping a public secret list", () => {
    const policy = new MemorySensitiveDataPolicy();
    const secret = 'private\n"value"';
    policy.remember(secret);
    expect(policy.sanitizeText(`value=${secret}`)).toBe("value=[REDACTED]");
    expect(policy.sanitizeText(JSON.stringify({ value: secret }))).toBe('{"value":"[REDACTED]"}');
    expect(JSON.stringify(policy)).toBe("{}");
  });
  it("handles overlapping secrets in descending length", () => {
    const policy = new MemorySensitiveDataPolicy();
    policy.remember("abc");
    policy.remember("abcdef");
    expect(policy.sanitizeText("abcdef abc")).toBe("[REDACTED] [REDACTED]");
  });
});
