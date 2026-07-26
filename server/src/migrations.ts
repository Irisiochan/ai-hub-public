import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export function loadMigrationFiles(dir = DEFAULT_DIR): Migration[] {
  const names = fs.readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  if (names.length === 0) throw new Error(`no migration files found in ${dir}`);
  return names.map((name, index) => {
    const version = Number(name.slice(0, 4));
    const expected = index + 1;
    if (version !== expected) {
      throw new Error(`migration sequence gap: expected ${String(expected).padStart(4, '0')}, got ${name}`);
    }
    return { version, name, sql: fs.readFileSync(path.join(dir, name), 'utf-8') };
  });
}

export function loadMigrations(dir = DEFAULT_DIR): string[] {
  return loadMigrationFiles(dir).map((migration) => migration.sql);
}
