const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? args[promptIndex + 1] ?? '' : '';
const sessionIndex = Math.max(args.indexOf('-s'), args.indexOf('-r'));
const sessionId =
  sessionIndex >= 0 ? args[sessionIndex + 1] : '00000000-0000-4000-8000-000000000000';

if (prompt.includes('cancel')) {
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
