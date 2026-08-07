import type { Response } from 'express';

export type SseEvent =
  | 'message' // full persisted message row
  | 'delta' // { contactId, messageId, text } streaming append
  | 'status' // { contactId, state, detail? }
  | 'contact' // contact config changed
  | 'read-state' // persisted main/side read cursor changed
  | 'prune' // { contactId, ids?: number[], afterId?: number } messages removed
  | 'user' // user profile changed
  | 'worker'
  | 'job'
  | 'job-message';

export class SseHub {
  /** null subscriptions = legacy client receiving every contact delta. */
  private clients = new Map<Response, Set<string> | null>();
  private eventId = 0;
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients.keys()) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  addClient(res: Response, subscriptions: Set<string> | null = null): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    this.clients.set(res, subscriptions);
    res.on('close', () => this.clients.delete(res));
  }

  /** Write one event to a single client (e.g. status snapshot on connect). */
  send(res: Response, event: SseEvent, data: unknown): void {
    const subscriptions = this.clients.get(res);
    if (subscriptions === undefined || !this.shouldDeliver(event, data, subscriptions)) return;
    res.write(`id: ${++this.eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: SseEvent, data: unknown): void {
    const payload = `id: ${++this.eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, subscriptions] of this.clients) {
      if (this.shouldDeliver(event, data, subscriptions)) res.write(payload);
    }
  }

  private shouldDeliver(event: SseEvent, data: unknown, subscriptions: Set<string> | null): boolean {
    if (subscriptions === null || event !== 'delta') return true;
    const contactId = data && typeof data === 'object' && 'contactId' in data
      ? String((data as { contactId?: unknown }).contactId ?? '')
      : '';
    return !!contactId && subscriptions.has(contactId);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients.keys()) res.end();
    this.clients.clear();
  }
}
