#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const Database = requireFromServer('better-sqlite3');

const FORMAT = 'ai-hub-offsite-backup-v1';

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function safeStoredName(name) {
  return (
    typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && path.basename(name) === name
  );
}

function readSnapshot(dbFile) {
  const snapshot = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity}`);
    const messageCount = snapshot.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
    const attachments = snapshot.prepare(
      `SELECT id, message_id, stored_name, original_name, mime_type, size, created_at
       FROM message_attachments ORDER BY id`
    ).all();
    return { integrity, messageCount, attachments };
  } finally {
    snapshot.close();
  }
}

function normalizeManifestAttachment(row, file, hash) {
  return {
    id: row.id,
    messageId: row.message_id,
    storedName: row.stored_name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: row.created_at,
    sha256: hash,
    file,
  };
}

export async function createBundle({ dbPath, uploadsDir, outputDir, sourceCommit = null }) {
  const dbFile = path.resolve(dbPath);
  const uploadsRoot = path.resolve(uploadsDir);
  const bundleRoot = path.resolve(outputDir);
  const bundleDb = path.join(bundleRoot, 'hub.db');
  const bundleUploads = path.join(bundleRoot, 'uploads');

  if (fs.existsSync(bundleRoot)) throw new Error(`Output already exists: ${bundleRoot}`);
  fs.mkdirSync(bundleUploads, { recursive: true, mode: 0o700 });

  try {
    const live = new Database(dbFile, { fileMustExist: true });
    try {
      await live.backup(bundleDb);
    } finally {
      live.close();
    }

    const snapshot = readSnapshot(bundleDb);
    const manifestAttachments = [];
    for (const row of snapshot.attachments) {
      if (!safeStoredName(row.stored_name)) {
        throw new Error(`Unsafe attachment stored_name: ${JSON.stringify(row.stored_name)}`);
      }
      const source = path.join(uploadsRoot, row.stored_name);
      const target = path.join(bundleUploads, row.stored_name);
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw new Error(`Attachment is not a file: ${row.stored_name}`);
      if (stat.size !== row.size) {
        throw new Error(`Attachment size mismatch: ${row.stored_name} db=${row.size} disk=${stat.size}`);
      }
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      manifestAttachments.push(
        normalizeManifestAttachment(row, `uploads/${row.stored_name}`, sha256(target))
      );
    }

    const dbStat = fs.statSync(bundleDb);
    const manifest = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      sourceCommit,
      database: {
        file: 'hub.db',
        size: dbStat.size,
        sha256: sha256(bundleDb),
        integrityCheck: snapshot.integrity,
        messageCount: snapshot.messageCount,
        attachmentCount: manifestAttachments.length,
      },
      attachments: manifestAttachments,
    };
    fs.writeFileSync(
      path.join(bundleRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    return manifest;
  } catch (error) {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

export function verifyBundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== FORMAT) throw new Error(`Unsupported backup format: ${manifest.format}`);
  assertEqual(manifest.database.file, 'hub.db', 'Database file');

  const dbFile = path.join(root, manifest.database.file);
  const dbStat = fs.statSync(dbFile);
  assertEqual(dbStat.size, manifest.database.size, 'Database size');
  assertEqual(sha256(dbFile), manifest.database.sha256, 'Database SHA-256');

  const snapshot = readSnapshot(dbFile);
  assertEqual(snapshot.integrity, 'ok', 'SQLite integrity');
  assertEqual(snapshot.messageCount, manifest.database.messageCount, 'Message count');
  assertEqual(snapshot.attachments.length, manifest.database.attachmentCount, 'Attachment count');
  assertEqual(manifest.attachments.length, snapshot.attachments.length, 'Manifest attachment count');

  for (let i = 0; i < snapshot.attachments.length; i++) {
    const row = snapshot.attachments[i];
    const item = manifest.attachments[i];
    assertEqual(item.id, row.id, `Attachment[${i}] id`);
    assertEqual(item.messageId, row.message_id, `Attachment[${i}] messageId`);
    assertEqual(item.storedName, row.stored_name, `Attachment[${i}] storedName`);
    assertEqual(item.size, row.size, `Attachment[${i}] size`);
    if (!safeStoredName(item.storedName)) throw new Error(`Unsafe manifest storedName: ${item.storedName}`);
    const expectedFile = `uploads/${item.storedName}`;
    assertEqual(item.file, expectedFile, `Attachment[${i}] file`);
    const file = path.join(root, 'uploads', item.storedName);
    const stat = fs.statSync(file);
    assertEqual(stat.size, item.size, `Attachment[${i}] disk size`);
    assertEqual(sha256(file), item.sha256, `Attachment[${i}] SHA-256`);
  }

  return {
    ok: true,
    format: manifest.format,
    createdAt: manifest.createdAt,
    sourceCommit: manifest.sourceCommit,
    messageCount: manifest.database.messageCount,
    attachmentCount: manifest.database.attachmentCount,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    args[key.slice(2)] = value;
  }
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'create') {
    for (const key of ['db', 'uploads', 'output']) {
      if (!args[key]) throw new Error(`Missing --${key}`);
    }
    const manifest = await createBundle({
      dbPath: args.db,
      uploadsDir: args.uploads,
      outputDir: args.output,
      sourceCommit: args.commit ?? null,
    });
    console.log(JSON.stringify({
      ok: true,
      output: path.resolve(args.output),
      messageCount: manifest.database.messageCount,
      attachmentCount: manifest.database.attachmentCount,
    }));
    return;
  }
  if (command === 'verify') {
    if (!args.bundle) throw new Error('Missing --bundle');
    console.log(JSON.stringify(verifyBundle(args.bundle)));
    return;
  }
  throw new Error('Usage: offsite-backup.mjs create --db FILE --uploads DIR --output DIR [--commit SHA] | verify --bundle DIR');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`offsite-backup: ${error.message}`);
    process.exitCode = 1;
  });
}
