import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';


const url = process.env.VAULT_SMOKE_URL ?? 'http://127.0.0.1:18900/mcp';
const token = process.env.VAULT_TOKEN ?? '';

const client = new Client({ name: 'ai-hub-vault-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined,
});

await client.connect(transport);

const tools = await client.listTools();
const names = new Set(tools.tools.map((tool) => tool.name));
for (const required of ['get_context', 'search_vault', 'write_inbox']) {
  if (!names.has(required)) throw new Error(`missing MCP tool: ${required}`);
}

const context = await client.callTool({ name: 'get_context', arguments: {} });
const contextText = context.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n');
if (!contextText.includes('核心记忆')) throw new Error('get_context returned no core memory');

const write = await client.callTool({
  name: 'write_inbox',
  arguments: {
    slug: 'http-smoke',
    title: 'HTTP smoke note',
    content: 'ai-hub reached the bundled Memory Vault over authenticated MCP.',
    tags: ['smoke'],
    source: 'ai-hub-smoke',
  },
});
if (write.isError) throw new Error('write_inbox returned an MCP error');

await client.close();
console.log(`bundled vault HTTP smoke: ok (${tools.tools.length} tools)`);
