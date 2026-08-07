import type { Message, MessageOrigin } from './api';
import { effectiveMessageOrigin } from './messageSource.ts';

export function messagesForChannel(messages: Message[], channel: MessageOrigin): Message[] {
  return messages.filter((message) => effectiveMessageOrigin(message) === channel);
}

export function shouldMarkSideUnread(
  message: Pick<Message, 'contact_id' | 'content' | 'meta' | 'origin'>,
  activeContactId: string | null,
  activeChannel: MessageOrigin
): boolean {
  return effectiveMessageOrigin(message) === 'side'
    && !(message.contact_id === activeContactId && activeChannel === 'side');
}
