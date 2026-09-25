import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BackupConfig {
  enabled: boolean;
  /** 快照目录；应在仓库外（prod 默认 /var/backups/ai-hub/db） */
  dir: string;
  /** 最新快照早于该时长才做新备份 */
  intervalHours: number;
  /** 保留最近 N 份 */
  keep: number;
}

export interface PurgeConfig {
  enabled: boolean;
  /** 软删消息保留天数；超过后物理删除 */
  messagesRetentionDays: number;
  /** 已隐藏且终态的 job 保留天数 */
  jobsRetentionDays: number;
  /** 定时检查间隔（小时） */
  intervalHours: number;
  /** 单次最多清理条数（防一次锁太久） */
  batchSize: number;
}

export interface ProjectTargetConfig {
  repoId: string;
  platform: 'linux' | 'win32';
  workerId: string;
  /** Mapped VPS root, e.g. /srv/ai-dev/jobs. Task fences live one level below it. */
  workspace: string;
  runners: string[];
  ssh: boolean;
  shell?: boolean;
}

export interface HubConfig {
  port: number;
  host: string;
  /**
   * Extra addresses to bind the same port on, beyond `host`. Empty by default.
   * Loopback is added automatically (see resolveListenHosts) — this is only for
   * a second real interface.
   */
  extraHosts: string[];
  dbPath: string;
  agentsDir: string;
  webDist: string;
  uploadsDir: string;
  releasesDir: string;
  claude: {
    cliPath: string;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  };
  codex: {
    cliPath: string;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
    nativeCompact?: {
      enabled?: boolean;
      inputTokens?: number;
    };
  };
  grok: {
    cliPath: string;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  };
  opencode: {
    cliPath: string;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  };
  kimi: {
    cliPath: string;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  };
  /**
   * backend=api（直连 API 与 DSH harness）的单轮硬截止。CLI 后端不看这里，
   * 它们走 turnIdleTimeoutMs / turnHardTimeoutMs 两段计时（backends/turnTimeouts.ts）。
   */
  api: {
    turnTimeoutMs: number;
  };
  memory: MemoryConfig;
  backup: BackupConfig;
  purge: PurgeConfig;
  /**
   * Workflow-only background operation (2026-09-12).
   * Master boundary: when enabled, all ancillary proactive messaging and
   * auxiliary DS hooks stay off even if per-contact flags opt in:
   * memory capture, natural-language taskWriteback,
   * life-events extraction, CompanionHeartbeat ticks/sessions.
   * Preserved: normal user chat (incl. DS-model backends), in-place receipt
   * state updates, JobStore/task-projection outbox, health,
   * backup/purge/quota read-only lifecycle. Requires gateway restart to take
   * effect (config is read once at startup).
   */
  workflowOnly?: {
    enabled?: boolean;
  };
  /**
   * G02 VPS pilot target map (2026-09-16). Optional; defaults to empty.
   * Every field (workerId/workspace/runners/ssh) comes from this config —
   * the gateway ships no built-in worker or path defaults. Accepts a
   * keyed object or an array of entries; invalid entries are dropped.
   */
  projectTargets?: Record<string, ProjectTargetConfig>;
}

/** Master guard: per-contact memory.capture/lifeEvents/heartbeat flags cannot override. */
export function isWorkflowOnlyEnabled(config?: { workflowOnly?: { enabled?: unknown } } | null): boolean {
  return (config as { workflowOnly?: { enabled?: unknown } } | null | undefined)?.workflowOnly?.enabled === true;
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

// This file lives at <server>/{src,dist}/platform/, two levels below the server root.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 200k is deliberately conservative: about 74% of a 272k Codex context.
// Keep it explicit because app-server supports multiple models and the gateway
// has no single model-window constant that is valid for every contact.
export const DEFAULT_CODEX_NATIVE_COMPACT_INPUT_TOKENS = 200_000;

const defaults: HubConfig = {
  port: 3900,
  host: '127.0.0.1',
  extraHosts: [],
  dbPath: 'data/hub.db',
  agentsDir: 'agents',
  webDist: '../web/dist',
  uploadsDir: 'data/uploads',
  releasesDir: process.platform === 'linux' ? '/var/lib/ai-hub/releases' : 'data/releases',
  claude: {
    cliPath: 'claude',
    turnIdleTimeoutMs: 300_000,
    turnHardTimeoutMs: 900_000,
  },
  codex: {
    cliPath: 'codex',
    turnIdleTimeoutMs: 300_000,
    turnHardTimeoutMs: 900_000,
    nativeCompact: {
      enabled: true,
      inputTokens: DEFAULT_CODEX_NATIVE_COMPACT_INPUT_TOKENS,
    },
  },
  grok: {
    cliPath: 'grok',
    turnIdleTimeoutMs: 300_000,
    turnHardTimeoutMs: 900_000,
  },
  opencode: {
    cliPath: 'opencode',
    turnIdleTimeoutMs: 300_000,
    turnHardTimeoutMs: 900_000,
  },
  kimi: {
    cliPath: 'kimi',
    turnIdleTimeoutMs: 300_000,
    turnHardTimeoutMs: 900_000,
  },
  api: {
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
  workflowOnly: {
    enabled: false,
  },
  projectTargets: {},
};

/** G02: validate one projectTargets entry; null when invalid (dropped, fail closed). */
export function normalizeProjectTargetEntry(raw: unknown): ProjectTargetConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const repoId = typeof entry.repoId === 'string' ? entry.repoId.trim() : '';
  const platform = typeof entry.platform === 'string' ? entry.platform.trim() : '';
  const workerId = typeof entry.workerId === 'string' ? entry.workerId.trim() : '';
  const workspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
  if (!repoId || (platform !== 'linux' && platform !== 'win32')) return null;
  if (!workerId || !workspace) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/)[^\r\n]+$/.test(workspace)) return null;
  const runnersRaw = entry.runners;
  const runners = Array.isArray(runnersRaw)
    ? runnersRaw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
    : [];
  if (runners.length === 0) return null;
  if (typeof entry.ssh !== 'boolean') return null;
  const shell = entry.shell === undefined ? undefined : entry.shell === true;
  return {
    repoId,
    platform,
    workerId,
    workspace: workspace.replace(/\/+$/, '') || '/',
    runners,
    ssh: entry.ssh,
    ...(shell === undefined ? {} : { shell }),
  };
}

/** G02: normalize the projectTargets config item; missing/invalid means empty (no targets). */
export function normalizeProjectTargets(raw: unknown): Record<string, ProjectTargetConfig> {
  const out: Record<string, ProjectTargetConfig> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? (raw as unknown[]).map((item) => [String((item as Record<string, unknown>)?.repoId ?? ''), item])
    : Object.entries(raw as Record<string, unknown>);
  for (const [key, value] of entries) {
    const normalized = normalizeProjectTargetEntry(value);
    if (!normalized) continue;
    out[normalized.repoId || key] = normalized;
  }
  return out;
}

const WILDCARD_HOSTS = new Set(['', '*', '0.0.0.0', '::', '[::]']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Listen addresses for the gateway, in bind order.
 *
 * The VPS binds `host` to its tailnet address so phones/PC can reach it, and
 * express only ever binds ONE address — which used to leave `127.0.0.1:3900`
 * dead. Everything co-located on that box (the vps-dev worker, merge/deploy
 * closure scripts, curl checks) then had to hardcode the tailnet IP, i.e. the
 * gateway's own host depended on the tailnet being up. So: whenever `host` is
 * a specific non-loopback address, loopback is bound too. A wildcard host
 * already covers loopback, and a loopback host is already loopback.
 */
export function resolveListenHosts(cfg: Pick<HubConfig, 'host' | 'extraHosts'>): string[] {
  const primary = String(cfg.host ?? '').trim();
  const hosts = [primary, ...(cfg.extraHosts ?? []).map((item) => String(item ?? '').trim())];
  const key = primary.toLowerCase();
  if (!WILDCARD_HOSTS.has(key) && !LOOPBACK_HOSTS.has(key)) hosts.push('127.0.0.1');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of hosts) {
    if (!host) continue;
    const dedupe = host.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(host);
  }
  return out.length > 0 ? out : [primary];
}

function normalizeExtraHosts(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return raw.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}

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
    opencode: { ...defaults.opencode, ...(user.opencode ?? {}) },
    kimi: { ...defaults.kimi, ...(user.kimi ?? {}) },
    api: { ...defaults.api, ...(user.api ?? {}) },
    memory: { ...defaults.memory, ...(user.memory ?? {}) },
    backup: { ...defaults.backup, ...(user.backup ?? {}) },
    purge: { ...defaults.purge, ...(user.purge ?? {}) },
    workflowOnly: {
      enabled: (user.workflowOnly as { enabled?: unknown } | undefined)?.enabled === true,
    },
    projectTargets: normalizeProjectTargets(
      (user as { projectTargets?: unknown }).projectTargets,
    ),
    extraHosts: normalizeExtraHosts((user as { extraHosts?: unknown }).extraHosts),
  };
  // env overrides (desktop shell); absent vars leave web/VPS behavior untouched
  if (process.env.HUB_PORT) cfg.port = Number(process.env.HUB_PORT);
  if (process.env.HUB_HOST) cfg.host = process.env.HUB_HOST;
  if (process.env.HUB_EXTRA_HOSTS) cfg.extraHosts = normalizeExtraHosts(process.env.HUB_EXTRA_HOSTS);
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
