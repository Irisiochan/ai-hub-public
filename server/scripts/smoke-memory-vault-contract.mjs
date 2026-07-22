import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.VAULT_SMOKE_URL ?? 'http://127.0.0.1:8900/mcp';
const token = process.env.VAULT_TOKEN ?? '';

const client = new Client({ name: 'ai-hub-memory-vault-contract', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined,
});

await client.connect(transport);

const tools = await client.listTools();
const names = new Set(tools.tools.map((tool) => tool.name));
const requiredTools = [
  'get_context',
  'get_core_context',
  'get_turn_time',
  'get_task_context',
  'search_vault',
  'read_file',
  'write_inbox',
  'add_task',
  'update_task',
];
for (const required of requiredTools) {
  if (!names.has(required)) throw new Error(`missing MCP tool: ${required}`);
}

const core = await client.callTool({ name: 'get_core_context', arguments: {} });
if (core.isError) throw new Error('get_core_context returned an MCP error');

const context = await client.callTool({ name: 'get_context', arguments: {} });
const contextText = context.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n');
if (!contextText.includes('核心记忆')) throw new Error('get_context returned no core memory');

const write = await client.callTool({
  name: 'write_inbox',
  arguments: {
    slug: 'http-contract-smoke',
    title: 'HTTP contract smoke note',
    content: 'AI Hub reached its versioned Memory Vault dependency over MCP.',
    tags: ['smoke'],
    source: 'ai-hub-smoke',
  },
});
if (write.isError) throw new Error('write_inbox returned an MCP error');

await client.close();
console.log(`Memory Vault MCP contract: ok (${tools.tools.length} tools)`);
