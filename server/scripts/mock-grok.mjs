const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? args[promptIndex + 1] ?? '' : '';
const sessionIndex = Math.max(args.indexOf('-s'), args.indexOf('-r'));
const sessionId =
  sessionIndex >= 0 ? args[sessionIndex + 1] : '00000000-0000-4000-8000-000000000000';

if (prompt.includes('flags')) {
  // 让 smoke 能断言真正传给 CLI 的参数（权限相关的 flag 漏传是静默失败）
  console.log(JSON.stringify({ type: 'text', data: JSON.stringify(args) }));
  console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId }));
} else if (prompt.includes('tools')) {
  console.log(
    JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call_1',
      title: 'Search tools',
      kind: 'other',
      status: 'in_progress',
      toolName: 'search_tool',
      rawInput: { query: 'write_memory' },
    })
  );
  console.log(
    JSON.stringify({
      type: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { result_count: 3 },
    })
  );
  console.log(JSON.stringify({ type: 'text', data: '查完了。' }));
  console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId }));
} else if (prompt.includes('stuck')) {
  // 工具起了头但没有终态更新，然后整轮 cancelled——生产里的真实形态
  console.log(
    JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call_9',
      status: 'in_progress',
      toolName: 'search_tool',
      rawInput: { query: 'write_memory' },
    })
  );
  console.log(JSON.stringify({ type: 'text', data: '我先查一下参数。' }));
  console.log(JSON.stringify({ type: 'end', stopReason: 'cancelled', sessionId }));
} else if (prompt.includes('cancel')) {
  console.log(JSON.stringify({ type: 'text', data: '这只是半截回复。' }));
  console.log(
    JSON.stringify({
      type: 'end',
      stopReason: 'cancelled',
      sessionId,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
} else {
  console.log(JSON.stringify({ type: 'text', data: '完整结论。' }));
  console.log(
    JSON.stringify({
      type: 'end',
      stopReason: 'end_turn',
      sessionId,
      usage: { inputTokens: 8, outputTokens: 4 },
    })
  );
}
