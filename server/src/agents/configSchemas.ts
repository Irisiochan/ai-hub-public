export * from '@ai-hub/contact-config';

import {
  parseStoredContactConfig,
  type ContactConfig,
} from '@ai-hub/contact-config';
import type { ContactRow } from '../db.js';

/** Parse a DB row once. Non-enumerable prevents raw secrets leaking through `{ ...row }`. */
export function openContact<T extends ContactRow>(row: T): T {
  if (!row.configParsed) {
    Object.defineProperty(row, 'configParsed', {
      value: parseStoredContactConfig(row.backend, row.kind, row.config),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return row;
}

export function contactConfig(row: ContactRow): ContactConfig {
  return openContact(row).configParsed!;
}
