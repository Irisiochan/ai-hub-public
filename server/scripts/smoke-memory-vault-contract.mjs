import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.VAULT_SMOKE_URL ?? 'http://127.0.0.1:18900/mcp';
const token = process.env.VAULT_TOKEN ?? '';

const client = new Client({ name: 'ai-hub-memory-vault-contract', version: '0.2.1' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined,
});

function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function requireStructured(result, expectedOk, expectedCode) {
  if (result.isError) throw new Error(`update_task returned an MCP error: ${textOf(result)}`);
  const structured = result.structuredContent;
  if (!structured || structured.ok !== expectedOk || structured.code !== expectedCode) {
    throw new Error(`unexpected update_task structured result: ${JSON.stringify(structured)}`);
  }
  const text = textOf(result);
  const parsed = JSON.parse(text);
  if (parsed.ok !== expectedOk || parsed.code !== expectedCode) {
    throw new Error(`unexpected update_task text result: ${text}`);
  }
  return structured;
}

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

  const created = await client.callTool({
    name: 'add_task',
    arguments: {
      slug: 'ai-hub-contract-reschedule',
      title: 'AI Hub reschedule contract',
      due: '2026-07-30',
      content: 'Created by the AI Hub contract test.',
      tags: ['smoke'],
      source: 'ai-hub-ci',
    },
  });
  if (created.isError) throw new Error(`add_task returned an MCP error: ${textOf(created)}`);

  const rescheduled = await client.callTool({
    name: 'update_task',
    arguments: {
      path: 'tasks/ai-hub-contract-reschedule.md',
      status: 'open',
      due: '2026-08-10',
      note: 'AI Hub projected the new due date.',
      source: 'ai-hub-ci',
    },
  });
  requireStructured(rescheduled, true, 'task_updated');

  const reread = await client.callTool({
    name: 'read_file',
    arguments: { path: 'tasks/ai-hub-contract-reschedule.md' },
  });
  if (reread.isError || !/due:\s*['"]?2026-08-10['"]?/.test(textOf(reread))) {
    throw new Error(`rescheduled due was not readable from Vault: ${textOf(reread)}`);
  }

  const missing = await client.callTool({
    name: 'update_task',
    arguments: {
      path: 'tasks/ai-hub-contract-missing.md',
      status: 'open',
      note: 'Missing files must not look successful.',
      source: 'ai-hub-ci',
    },
  });
  requireStructured(missing, false, 'not_found');

  const completed = await client.callTool({
    name: 'update_task',
    arguments: {
      path: 'tasks/ai-hub-contract-reschedule.md',
      status: 'done',
      note: 'Contract cleanup.',
      source: 'ai-hub-ci',
    },
  });
  requireStructured(completed, true, 'task_archived');

  console.log(`Memory Vault MCP contract: ok (${tools.tools.length} tools; due write-read + structured failures)`);
} finally {
  await client.close();
}
