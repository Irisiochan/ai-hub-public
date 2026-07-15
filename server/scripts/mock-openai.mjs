#!/usr/bin/env node
/** Minimal OpenAI-compatible SSE server for testing the directApi backend. */
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 3999);

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const last = parsed.messages[parsed.messages.length - 1]?.content ?? '';
      const hasSystem = parsed.messages[0]?.role === 'system';
      const reply = `mock-api 收到（模型 ${parsed.model}，system:${hasSystem ? '有' : '无'}，历史 ${parsed.messages.length} 条）：「${last.slice(0, 40)}」中文🍊ok`;

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = reply.match(/[\s\S]{1,6}/g) ?? [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`
          );
        } else {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: chunks.length } })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
        }
      }, 60);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock-openai on http://127.0.0.1:${PORT}`));
