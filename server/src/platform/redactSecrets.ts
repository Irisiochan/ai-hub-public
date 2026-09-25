/**
 * Scrub credential material from text that is about to become user-visible
 * (chat error rows, runtime error state). Backend boot errors can echo raw
 * config values — a codex config parse error quotes the offending value,
 * which for hub-mcp http_headers is a live per-contact bearer token.
 */

const PATTERNS: RegExp[] = [
  /(bearer[\s:=]+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:authorization|api[_-]?key|token|secret)\\?["']?\s*[:=]\s*\\?["']?\s*)[A-Za-z0-9._~+/=-]{16,}/gi,
];

export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const pattern of PATTERNS) out = out.replace(pattern, '$1[REDACTED_SECRET]');
  return out;
}
