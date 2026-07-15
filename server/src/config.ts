import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackupConfig } from './backup.js';

export interface HubConfig {
  port: number;
  host: string;
  dbPath: string;
  agentsDir: string;
  webDist: string;
  uploadsDir: string;
  claude: {
    cliPath: string;
    turnTimeoutMs: number;
  };
  codex: {
    cliPath: string;
    turnTimeoutMs: number;
  };
  memory: MemoryConfig;
  backup: BackupConfig;
}

export interface MemoryConfig {
  /** streamable-http MCP endpoint of the vault server; null disables the whole memory layer */
  mcpUrl: string | null;
  /** Git checkout used by the publish-status panel; null means unavailable. */
  repoPath: string | null;
  injectOnSpawn: boolean;
  searchPerTurn: boolean;
  capture: boolean;
  maxTurnChars: number;
  sessionMaxAgeHours: number;
}

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults: HubConfig = {
  port: 3900,
  host: '127.0.0.1',
  dbPath: 'data/hub.db',
  agentsDir: 'agents',
  webDist: '../web/dist',
  uploadsDir: 'data/uploads',
  claude: {
    cliPath: 'claude',
    turnTimeoutMs: 300_000,
  },
  codex: {
    cliPath: 'codex',
    turnTimeoutMs: 300_000,
  },
  memory: {
    mcpUrl: null,
    repoPath: process.env.MEMORY_VAULT_REPO ?? null,
    injectOnSpawn: true,
    searchPerTurn: true,
    capture: true,
    maxTurnChars: 1200,
    sessionMaxAgeHours: 12,
  },
  backup: {
    enabled: true,
    // prod 放仓库外，防 update.sh 拒脏；dev 落在 gitignore 的 data/ 里
    dir: process.platform === 'linux' ? '/var/backups/ai-hub/db' : 'data/backups',
    intervalHours: 24,
    keep: 14,
  },
};

export function loadConfig(): HubConfig {
  const file = path.join(serverRoot, 'config.json');
  let user: Partial<HubConfig> = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  const cfg: HubConfig = {
    ...defaults,
    ...user,
    claude: { ...defaults.claude, ...(user.claude ?? {}) },
    codex: { ...defaults.codex, ...(user.codex ?? {}) },
    memory: { ...defaults.memory, ...(user.memory ?? {}) },
    backup: { ...defaults.backup, ...(user.backup ?? {}) },
  };
  // resolve relative paths against server root so cwd doesn't matter
  cfg.dbPath = path.resolve(serverRoot, cfg.dbPath);
  cfg.agentsDir = path.resolve(serverRoot, cfg.agentsDir);
  cfg.webDist = path.resolve(serverRoot, cfg.webDist);
  cfg.uploadsDir = path.resolve(serverRoot, cfg.uploadsDir);
  cfg.backup.dir = path.resolve(serverRoot, cfg.backup.dir);
  if (cfg.memory.repoPath) cfg.memory.repoPath = path.resolve(serverRoot, cfg.memory.repoPath);
  return cfg;
}

export { serverRoot };
