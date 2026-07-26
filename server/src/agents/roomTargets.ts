import type { ContactRow } from '../db.js';

export interface RoomTargetConfig {
  respondAllByDefault?: boolean;
}

/** Pure mention parser: @name/@id/@all. Only call it for user-authored messages. */
export function parseRoomTargets(
  members: ContactRow[],
  content: string,
  config: RoomTargetConfig
): ContactRow[] {
  if (members.length === 0) return [];
  const mentions = [...content.matchAll(/@([^\s@，。！？、,!?：:；;]+)/g)].map((match) =>
    match[1].toLowerCase()
  );
  if (mentions.length === 0) return config.respondAllByDefault === true ? members : [];
  if (mentions.some((mention) => mention === 'all' || mention === '所有人' || mention === '大家')) {
    return members;
  }
  return members.filter(
    (contact) => mentions.includes(contact.id.toLowerCase()) || mentions.includes(contact.name.toLowerCase())
  );
}
