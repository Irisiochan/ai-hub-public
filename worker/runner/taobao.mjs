// Taobao desktop-client bridge: the gateway (VPS) cannot reach the Taobao
// client's local MCP server (http://localhost:3654/mcp), so a `taobaoRequest`
// arrives through the same claim loop as camera `snapRequest`s and the Worker
// forwards it as a single MCP `tools/call`. Whether the bridge exists at all is
// a local Worker decision (`allowTaobao`), exactly like `allowCamera`.

export const DEFAULT_TAOBAO_MCP_URL = 'http://localhost:3654/mcp';
const MAX_RESULT_CHARS = 200_000;
const CALL_TIMEOUT_MS = 40_000;

export function taobaoCapabilities(cfg) {
  return cfg?.allowTaobao === true ? { taobao: true } : {};
}

export function taobaoMcpUrl(cfg) {
  const url = typeof cfg?.taobaoMcpUrl === 'string' ? cfg.taobaoMcpUrl.trim() : '';
  return url || DEFAULT_TAOBAO_MCP_URL;
}

/** Parse a streamable-HTTP MCP response body (plain JSON or SSE frames) into the reply for `id`. */
export function parseMcpResponse(contentType, body, id) {
  const text = String(body ?? '');
  const messages = [];
  if (/text\/event-stream/i.test(contentType ?? '')) {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch { /* ignore non-JSON frames */ }
    }
  } else if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new Error(`taobao MCP returned non-JSON body: ${text.slice(0, 200)}`);
    }
  }
  const reply = messages.find((message) => message && message.id === id);
  if (!reply) throw new Error(`taobao MCP response did not include reply id=${id}`);
  if (reply.error) {
    const message = typeof reply.error.message === 'string' ? reply.error.message : JSON.stringify(reply.error);
    throw new Error(`taobao MCP error: ${message}`);
  }
  return reply.result;
}

/** Minimal streamable-HTTP MCP client that keeps one session to the Taobao client. */
export class TaobaoMcpClient {
  constructor(url = DEFAULT_TAOBAO_MCP_URL, runtime = {}) {
    this.url = url;
    this.fetch = runtime.fetch ?? globalThis.fetch;
    this.sessionId = null;
    this.nextId = 1;
    this.initializing = null;
  }

  async #post(payload, { expectReply = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`taobao MCP unreachable at ${this.url}: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text();
    if (res.status === 404 || res.status === 400 && /session/i.test(body)) {
      const error = new Error('taobao MCP session rejected');
      error.sessionLost = true;
      throw error;
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`taobao MCP HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    if (!expectReply) return null;
    return parseMcpResponse(res.headers.get('content-type'), body, payload.id);
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.sessionId = null;
      const id = this.nextId++;
      const result = await this.#post({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ai-hub-pc-worker', version: '0.2.1' },
        },
      });
      await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectReply: false });
      return result;
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async #request(method, params) {
    if (!this.sessionId) await this.initialize();
    const id = this.nextId++;
    return this.#post({ jsonrpc: '2.0', id, method, params });
  }

  async call(method, params) {
    try {
      return await this.#request(method, params);
    } catch (error) {
      if (!error?.sessionLost) throw error;
      this.sessionId = null;
      return this.#request(method, params);
    }
  }

  listTools() {
    return this.call('tools/list', {});
  }

  callTool(name, args) {
    return this.call('tools/call', { name, arguments: args ?? {} });
  }
}

function boundedContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  let budget = MAX_RESULT_CHARS;
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (budget <= 0) break;
      const text = block.text.slice(0, budget);
      budget -= text.length;
      out.push({ type: 'text', text });
    } else if (block.type === 'image' && typeof block.data === 'string') {
      out.push({ type: 'text', text: `[image ${block.mimeType ?? 'image'} omitted by worker bridge]` });
    }
  }
  return out;
}

/**
 * Serve one gateway `taobaoRequest`. Returns false when the local gate is closed
 * or the request is malformed, so a smuggled request can never reach the client.
 */
export async function handleTaobaoRequest(cfg, request, post, client) {
  if (taobaoCapabilities(cfg).taobao !== true) return false;
  const requestId = typeof request?.id === 'string' ? request.id : '';
  const name = typeof request?.name === 'string' ? request.name.trim() : '';
  if (!requestId || !name) return false;
  const args = request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
    ? request.arguments
    : {};
  let payload;
  try {
    const result = await client.callTool(name, args);
    payload = { result: { content: boundedContent(result), isError: result?.isError === true } };
  } catch (error) {
    payload = { error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
  }
  await post(requestId, payload);
  return true;
}
