import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackupConfig } from './backup.js';
import type { PurgeConfig } from './purge.js';

export interface HubConfig {
  port: number;
  host: string;
  dbPath: string;
  agentsDir: string;
  webDist: string;
  uploadsDir: string;
  releasesDir: string;
  claude: {
    cliPath: string;
    turnTimeoutMs: number;
  };
  codex: {
    cliPath: string;
    turnTimeoutMs: number;
    nativeCompact?: {
      enabled?: boolean;
      inputTokens?: number;
    };
  };
  grok: {
    cliPath: string;
    turnTimeoutMs: number;
  };
  memory: MemoryConfig;
  backup: BackupConfig;
  purge: PurgeConfig;
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

// 200k is deliberately conservative: about 74% of a 272k Codex context.
// Keep it explicit because app-server supports multiple models and the gateway
// has no single model-window constant that is valid for every contact.
export const DEFAULT_CODEX_NATIVE_COMPACT_INPUT_TOKENS = 200_000;

const defaults: HubConfig = {
  port: 3900,
  host: '127.0.0.1',
  dbPath: 'data/hub.db',
  agentsDir: 'agents',
  webDist: '../web/dist',
  uploadsDir: 'data/uploads',
  releasesDir: process.platform === 'linux' ? '/var/lib/ai-hub/releases' : 'data/releases',
  claude: {
    cliPath: 'claude',
    turnTimeoutMs: 300_000,
  },
  codex: {
    cliPath: 'codex',
    turnTimeoutMs: 300_000,
    nativeCompact: {
      enabled: true,
      inputTokens: DEFAULT_CODEX_NATIVE_COMPACT_INPUT_TOKENS,
    },
  },
  grok: {
    cliPath: 'grok',
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
  purge: {
    enabled: true,
    messagesRetentionDays: 14,
    jobsRetentionDays: 30,
    intervalHours: 24,
    batchSize: 500,
  },
};

export function loadConfig(): HubConfig {
  // HUB_CONFIG lets the desktop shell point at a config.json outside the
  // install dir (e.g. %APPDATA%); default stays the checkout-local file.
  const file = process.env.HUB_CONFIG ?? path.join(serverRoot, 'config.json');
  let user: Partial<HubConfig> = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  const cfg: HubConfig = {
    ...defaults,
    ...user,
    claude: { ...defaults.claude, ...(user.claude ?? {}) },
    codex: {
      ...defaults.codex,
      ...(user.codex ?? {}),
      nativeCompact: {
        ...defaults.codex.nativeCompact,
        ...(user.codex?.nativeCompact ?? {}),
      },
    },
    grok: { ...defaults.grok, ...(user.grok ?? {}) },
    memory: { ...defaults.memory, ...(user.memory ?? {}) },
    backup: { ...defaults.backup, ...(user.backup ?? {}) },
    purge: { ...defaults.purge, ...(user.purge ?? {}) },
  };
  // env overrides (desktop shell); absent vars leave web/VPS behavior untouched
  if (process.env.HUB_PORT) cfg.port = Number(process.env.HUB_PORT);
  if (process.env.HUB_HOST) cfg.host = process.env.HUB_HOST;
  if (process.env.HUB_WEB_DIST) cfg.webDist = process.env.HUB_WEB_DIST;
  if (process.env.HUB_RELEASES_DIR) cfg.releasesDir = process.env.HUB_RELEASES_DIR;
  const nativeCompactInputTokens = Number(cfg.codex.nativeCompact?.inputTokens);
  cfg.codex.nativeCompact = {
    enabled: cfg.codex.nativeCompact?.enabled !== false,
    inputTokens: Number.isFinite(nativeCompactInputTokens) && nativeCompactInputTokens > 0
      ? Math.floor(nativeCompactInputTokens)
      : DEFAULT_CODEX_NATIVE_COMPACT_INPUT_TOKENS,
  };
  const dataDir = process.env.HUB_DATA_DIR;
  if (dataDir) {
    cfg.dbPath = path.join(dataDir, 'hub.db');
    cfg.uploadsDir = path.join(dataDir, 'uploads');
    cfg.agentsDir = path.join(dataDir, 'agents');
    cfg.backup.dir = path.join(dataDir, 'backups');
    if (!process.env.HUB_RELEASES_DIR) cfg.releasesDir = path.join(dataDir, 'releases');
  }
  // resolve relative paths against server root so cwd doesn't matter
  cfg.dbPath = path.resolve(serverRoot, cfg.dbPath);
  cfg.agentsDir = path.resolve(serverRoot, cfg.agentsDir);
  cfg.webDist = path.resolve(serverRoot, cfg.webDist);
  cfg.uploadsDir = path.resolve(serverRoot, cfg.uploadsDir);
  cfg.backup.dir = path.resolve(serverRoot, cfg.backup.dir);
  cfg.releasesDir = path.resolve(serverRoot, cfg.releasesDir);
  if (cfg.memory.repoPath) cfg.memory.repoPath = path.resolve(serverRoot, cfg.memory.repoPath);
  for (const dir of [path.dirname(cfg.dbPath), cfg.uploadsDir, cfg.agentsDir, cfg.releasesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

export { serverRoot };
