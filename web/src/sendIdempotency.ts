export interface SendMessageResult {
  messageId: number;
  persisted: true;
  queued: boolean | null;
  duplicate?: boolean;
  error?: string;
}

export interface MessageSendAttempt {
  contactId: string;
  content: string;
  images: readonly File[];
  idempotencyKey: string;
}

type ErrorBody = Record<string, unknown>;

export function createMessageIdempotencyKey(
  randomUUID: () => string = () => globalThis.crypto?.randomUUID?.() ?? ''
): string {
  const uuid = randomUUID().trim();
  if (uuid) return `message:${uuid}`.slice(0, 200);
  return `message:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function prepareMessageSendAttempt(
  previous: MessageSendAttempt | null,
  contactId: string,
  content: string,
  images: readonly File[],
  createKey: () => string = createMessageIdempotencyKey
): MessageSendAttempt {
  const samePayload = previous?.contactId === contactId
    && previous.content === content
    && previous.images.length === images.length
    && previous.images.every((image, index) => image === images[index]);
  if (samePayload) return previous;
  return {
    contactId,
    content,
    images: [...images],
    idempotencyKey: createKey(),
  };
}

export function buildMessageRequestBody(
  content: string,
  images: File[],
  idempotencyKey: string
): string | FormData {
  if (images.length === 0) return JSON.stringify({ content, idempotencyKey });
  const body = new FormData();
  body.set('content', content);
  body.set('idempotencyKey', idempotencyKey);
  for (const image of images) body.append('images', image, image.name);
  return body;
}

export function persistedSendResultFromError(
  body: ErrorBody
): SendMessageResult | null {
  const messageId = Number(body.messageId);
  if (body.persisted !== true || !Number.isInteger(messageId) || messageId <= 0) return null;
  return {
    messageId,
    persisted: true,
    queued: body.queued === true ? true : body.queued === false ? false : null,
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
  };
}
