import type { ProviderToolCall } from './provider.js';

export const DSML_TOOL_CALLS_OPEN = '<｜｜DSML｜｜tool_calls>';

const INVOKE_RE = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
const PARAM_RE = /<｜｜DSML｜｜parameter\s+name="([^"]+)"(?:\s+string="true")?>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseDsmlToolCalls(raw: string): ProviderToolCall[] {
  const calls: ProviderToolCall[] = [];
  for (const invoke of raw.matchAll(INVOKE_RE)) {
    const name = decode(invoke[1] ?? '').trim();
    if (!name) continue;
    const input: Record<string, unknown> = {};
    for (const parameter of (invoke[2] ?? '').matchAll(PARAM_RE)) {
      const key = decode(parameter[1] ?? '').trim();
      if (key) input[key] = decode(parameter[2] ?? '').trim();
    }
    calls.push({ name, input });
  }
  return calls;
}

/**
 * Keep a marker-sized tail so an opener split across SSE chunks is never
 * emitted as assistant text. Once detected, the rest of the round is hidden
 * from the visible stream and retained only for tool parsing.
 */
export class DsmlTextFilter {
  private pending = '';
  private dsml = '';
  private detected = false;

  push(chunk: string): string {
    if (!chunk) return '';
    if (this.detected) {
      this.dsml += chunk;
      return '';
    }
    this.pending += chunk;
    const marker = this.pending.indexOf(DSML_TOOL_CALLS_OPEN);
    if (marker >= 0) {
      const visible = this.pending.slice(0, marker);
      this.dsml = this.pending.slice(marker);
      this.pending = '';
      this.detected = true;
      return visible;
    }
    const keep = Math.min(this.pending.length, DSML_TOOL_CALLS_OPEN.length - 1);
    const visible = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(-keep);
    return visible;
  }

  finish(): { visible: string; detected: boolean; calls: ProviderToolCall[] } {
    if (!this.detected) {
      const visible = this.pending;
      this.pending = '';
      return { visible, detected: false, calls: [] };
    }
    return { visible: '', detected: true, calls: parseDsmlToolCalls(this.dsml) };
  }
}
