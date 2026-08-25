import path from 'node:path';
import Database from 'better-sqlite3';
import {
  collectInvariantReport,
  renderInvariantJson,
  renderInvariantMarkdown,
} from '../src/tasks/invariants.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : '';
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

const tasksDir = path.resolve(argument('--tasks-dir'));
const dbPath = path.resolve(argument('--db'));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const report = collectInvariantReport(db, tasksDir);
  process.stdout.write(`${renderInvariantJson(report)}\n\n---\n\n${renderInvariantMarkdown(report)}`);
} finally {
  db.close();
}
