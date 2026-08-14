import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.VAULT_SMOKE_URL ?? 'http://127.0.0.1:18900/mcp';
const token = process.env.VAULT_TOKEN ?? '';

const client = new Client({ name: 'ai-hub-memory-vault-contract', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined,
});

await client.connect(transport);

try {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  const requiredTools = [
    'get_context',
    'get_core_context',
    'get_turn_time',
    'get_task_context',
    'get_facts',
    'search_vault',
    'read_file',
    'write_inbox',
    'add_task',
    'update_task',
    'log_daily',
    'write_diary',
  ];
  for (const required of requiredTools) {
    if (!names.has(required)) throw new Error(`missing MCP tool: ${required}`);
  }

  for (const [name, args] of [
    ['get_core_context', { source: 'compact' }],
    ['get_task_context', {}],
    ['get_facts', { domain: '' }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an MCP error`);
    if (!result.content.some((block) => block.type === 'text')) {
      throw new Error(`${name} returned no text content`);
    }
  }

  const write = await client.callTool({
    name: 'write_inbox',
    arguments: {
      slug: 'ai-hub-contract-smoke',
      title: 'AI Hub contract smoke',
      content: 'AI Hub reached its pinned Memory Vault dependency over MCP.',
      tags: ['smoke'],
      source: 'ai-hub-ci',
    },
  });
  if (write.isError) throw new Error('write_inbox returned an MCP error');

  console.log(`Memory Vault MCP contract: ok (${tools.tools.length} tools)`);
} finally {
  await client.close();
}
