const args = process.argv.slice(2);

if (args[0] === 'models') {
  console.log('opencode-go/muse-spark-1.2-contributor');
  console.log('opencode-go/muse-spark-1.2');
  console.log('anthropic/claude-sonnet-4-6');
  console.log('openai/gpt-5');
  process.exit(0);
}

const runIndex = args.indexOf('run');
const formatIndex = args.indexOf('--format');
const sessionIndex = args.indexOf('--session');
const modelIndex = Math.max(args.indexOf('-m'), args.indexOf('--model'));
const dash = args.indexOf('--');
const prompt = dash >= 0 ? args.slice(dash + 1).join(' ') : '';
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'ses_mock_new';

if (runIndex < 0 || formatIndex < 0 || args[formatIndex + 1] !== 'json') {
  console.error('expected: run --format json');
  process.exit(2);
}

function waitForStdinClose(ms = 1000) {
  if (process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('stdin was not closed');
      process.exit(3);
    }, ms);
    process.stdin.resume();
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

await waitForStdinClose();

function emit(type, extra = {}) {
  console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: sessionId, ...extra }));
}

if (prompt.includes('flags')) {
  emit('text', { part: { type: 'text', text: JSON.stringify(args) } });
} else if (prompt.includes('fail')) {
  emit('error', { error: { name: 'ProviderError', data: { message: 'catalog 401' } } });
} else if (prompt.includes('think')) {
  emit('reasoning', { part: { type: 'reasoning', text: '先想一下。' } });
  emit('text', { part: { type: 'text', text: '想完了。' } });
} else {
  emit('text', { part: { type: 'text', text: '缪斯在。' } });
}
process.exit(prompt.includes('fail') ? 1 : 0);
