import type { SensitiveDataPolicy } from "../contracts/index.js";

export class MemorySensitiveDataPolicy implements SensitiveDataPolicy {
  readonly #values = new Set<string>();
  remember(value: string): void {
    if (value) this.#values.add(value);
  }
  sanitizeText(value: string): string {
    let result = value;
    const variants = [...this.#values]
      .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
      .sort((a, b) => b.length - a.length);
    for (const secret of variants) result = result.split(secret).join("[REDACTED]");
    return result;
  }
}
