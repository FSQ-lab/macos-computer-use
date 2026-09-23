/** Memory-only boundary for known secret values; implementations never expose the set. */
export interface SensitiveDataPolicy {
  remember(value: string): void;
  sanitizeText(value: string): string;
}
