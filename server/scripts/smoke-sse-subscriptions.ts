import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SseHub } from '../dist/sse.js';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  writeHead(): void {}
  write(chunk: string): void { this.chunks.push(chunk); }
  end(): void {}
  events(name: string): string[] { return this.chunks.filter((chunk) => chunk.includes(`event: ${name}\n`)); }
}

const hub = new SseHub();
const legacy = new FakeResponse();
const a = new FakeResponse();
const b = new FakeResponse();
hub.addClient(legacy as any, null);
hub.addClient(a as any, new Set(['a']));
hub.addClient(b as any, new Set(['b']));

hub.broadcast('delta', { contactId: 'a', messageId: 1, text: 'x' });
assert.equal(legacy.events('delta').length, 1, 'legacy clients keep receiving deltas');
assert.equal(a.events('delta').length, 1, 'matching subscriber receives delta');
assert.equal(b.events('delta').length, 0, 'non-matching subscriber does not receive delta');

hub.broadcast('message', { contact_id: 'a', id: 1 });
assert.equal(legacy.events('message').length, 1);
assert.equal(a.events('message').length, 1);
assert.equal(b.events('message').length, 1, 'final messages remain global for unread counters');

hub.close();
console.log('sse subscriptions smoke: ok');
