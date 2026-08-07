import type { Message, MessageOrigin, MessageReadState } from './api';
import { effectiveMessageOrigin, isManualUserMessage } from './messageSource.ts';

export function countsAsUnread(message: Message): boolean {
  return (message.kind === 'text' || message.kind === 'error') && !isManualUserMessage(message);
}

export function incrementReadStateForIncoming(
  current: MessageReadState | undefined,
  message: Message,
  alreadyPresent: boolean
): MessageReadState | undefined {
  if (alreadyPresent || !countsAsUnread(message)) return current;
  const origin = effectiveMessageOrigin(message) as MessageOrigin;
  return {
    origin,
    lastReadMessageId: current?.lastReadMessageId ?? 0,
    firstUnreadId: current?.firstUnreadId ?? message.id,
    unreadCount: (current?.unreadCount ?? 0) + 1,
  };
}

export function unreadHydrationAfter(state: MessageReadState, loadedIds: number[]): number | null {
  if (state.firstUnreadId === null || loadedIds.includes(state.firstUnreadId)) return null;
  return state.lastReadMessageId;
}
