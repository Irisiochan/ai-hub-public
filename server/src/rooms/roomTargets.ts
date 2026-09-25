import type { ContactRow } from '../platform/index.js';

export interface RoomTargetConfig {
  respondAllByDefault?: boolean;
}

function roomMentions(content: string): string[] {
  return [...content.matchAll(/@([^\s@，。！？、,!?：:；;]+)/g)].map((match) =>
    match[1].toLowerCase()
  );
}

/** True only for an explicit @id/@name; @all stays a group mention. */
export function roomDirectlyMentions(
  contact: Pick<ContactRow, 'id' | 'name'>,
  content: string
): boolean {
  const mentions = roomMentions(content);
  return mentions.includes(contact.id.toLowerCase()) || mentions.includes(contact.name.toLowerCase());
}

/** True when the content carries an explicit @all-style group mention. */
export function roomMentionsAll(content: string): boolean {
  return roomMentions(content).some(
    (mention) => mention === 'all' || mention === '所有人' || mention === '大家'
  );
}

/**
 * Fixed-module pre-call filter for workflow rooms. Unbound reserve members
 * never wake — not from ordinary messages, @all, reactions or receipts — and
 * a bound member wakes only for its applicable module. Non-workflow rooms are
 * untouched (caller bypasses this helper entirely).
 */
export function filterWorkflowRoomTargets(
  members: ContactRow[],
  content: string,
  allowedIds: Set<string>,
): ContactRow[] {
  void content;
  if (members.length === 0 || allowedIds.size === 0) return [];
  return members.filter((contact) => allowedIds.has(contact.id));
}

/** Pure mention parser: @name/@id/@all. Only call it for user-authored messages. */
export function parseRoomTargets(
  members: ContactRow[],
  content: string,
  config: RoomTargetConfig
): ContactRow[] {
  if (members.length === 0) return [];
  const mentions = roomMentions(content);
  if (mentions.length === 0) return config.respondAllByDefault === true ? members : [];
  if (mentions.some((mention) => mention === 'all' || mention === '所有人' || mention === '大家')) {
    return members;
  }
  return members.filter(
    (contact) => mentions.includes(contact.id.toLowerCase()) || mentions.includes(contact.name.toLowerCase())
  );
}
