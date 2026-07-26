import { z } from 'zod';

const trimmed = (max = 4000) => z.string().trim().max(max);
const optionalText = (max = 4000) => z.string().max(max).optional();
const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().url().max(2000).optional()
);
const positiveInt = (fallback, max) => z.coerce.number().int().positive().max(max).default(fallback);

export const MemoryConfigSchema = z.object({
  // Contact values stay optional: absent means inherit the global memory config.
  injectOnSpawn: z.boolean().optional(),
  searchPerTurn: z.boolean().optional(),
  capture: z.boolean().optional(),
  maxTurnChars: z.coerce.number().int().positive().max(100_000).optional(),
  sessionMaxAgeHours: z.coerce.number().min(0).max(24 * 365).optional(),
}).passthrough().default({});

export const ProjectAccessSchema = z.object({
  enabled: z.boolean().default(false),
  workspace: z.string().max(1000).default(''),
  allowShell: z.boolean().default(false),
}).passthrough().default({});

export const DelegationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaces: z.array(trimmed(1000).min(1)).max(50).default([]),
  runners: z.array(z.enum(['claude', 'codex', 'grok'])).max(3).default(['claude', 'codex', 'grok']),
  allowShell: z.boolean().default(false),
  allowSsh: z.boolean().default(false),
  workerId: trimmed(200).optional(),
  maxOpenJobs: z.coerce.number().int().min(1).max(10).default(3),
}).passthrough().default({});

const modelOption = z.union([
  trimmed(200).min(1),
  z.object({ id: trimmed(200).min(1), label: trimmed(300).optional() }).passthrough(),
]);

const commonShape = {
  cliPath: optionalText(1000),
  cwd: optionalText(1000),
  model: z.string().trim().max(200).default(''),
  modelOptions: z.array(modelOption).max(100).default([]),
  effort: z.string().trim().max(40).default(''),
  memory: MemoryConfigSchema,
  delegation: DelegationConfigSchema,
  projectAccess: ProjectAccessSchema,
  maxSessionInputTokens: positiveInt(120_000, 10_000_000),
  roomDeliveryMaxChars: positiveInt(12_000, 200_000),
  roomDeliveryMaxMessages: positiveInt(40, 200),
};

export const ClaudeContactConfigSchema = z.object({
  ...commonShape,
  allowedTools: z.array(trimmed(300).min(1)).max(200).default([]),
  disallowedTools: z.array(trimmed(300).min(1)).max(200).default([]),
  appendSystemPrompt: optionalText(200_000),
  permissionMode: optionalText(100),
  mcpConfig: optionalText(200_000),
}).passthrough();

export const CodexContactConfigSchema = z.object({
  ...commonShape,
  developerInstructions: optionalText(200_000),
}).passthrough();

export const GrokContactConfigSchema = z.object({
  ...commonShape,
  appendSystemPrompt: optionalText(200_000),
}).passthrough();

export const ApiContactConfigSchema = z.object({
  ...commonShape,
  provider: z.enum(['anthropic', 'openai-compat', 'gemini']).default('openai-compat'),
  baseUrl: optionalUrl,
  apiKey: z.string().max(20_000).optional(),
  apiKeyRef: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional(),
  visionModel: trimmed(200).optional(),
  supportsImages: z.boolean().optional(),
  systemPrompt: optionalText(200_000),
  maxHistoryMessages: positiveInt(60, 1000),
  historyTokenBudget: positiveInt(8000, 10_000_000),
  minRecentTurns: positiveInt(6, 1000),
  summaryMaxTokens: positiveInt(3000, 1_000_000),
  historySummaryStrategy: z.enum(['extractive', 'off', 'external']).default('extractive'),
  memoryPreambleMode: z.enum(['full', 'compact', 'off']).default('compact'),
  promptCache: z.enum(['auto', 'off']).default('auto'),
  maxTokens: positiveInt(4096, 1_000_000),
  contextWindowTokens: z.coerce.number().int().min(0).max(10_000_000).default(128_000),
}).passthrough();

export const RoomContactConfigSchema = z.object({
  members: z.array(trimmed(200).min(1)).max(100).default([]),
  reactionRounds: z.coerce.number().int().min(0).max(3).default(1),
  respondAllByDefault: z.boolean().default(false),
  memory: MemoryConfigSchema,
}).passthrough();

export const ContactConfigSchemas = {
  'claude-cli': ClaudeContactConfigSchema,
  codex: CodexContactConfigSchema,
  'grok-cli': GrokContactConfigSchema,
  api: ApiContactConfigSchema,
  room: RoomContactConfigSchema,
};

export function contactConfigSchema(backend, kind = 'dm') {
  if (kind === 'room' || backend === 'room') return RoomContactConfigSchema;
  return ContactConfigSchemas[backend] ?? ApiContactConfigSchema;
}

function derivedDefaults(backend, parsed) {
  if (backend !== 'api') return parsed;
  if (parsed.baseUrl) return parsed;
  const baseUrl = parsed.provider === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : parsed.provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse'
      : 'https://api.openai.com/v1/chat/completions';
  return { ...parsed, baseUrl };
}

export function parseStoredContactConfig(backend, kind, raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw || '{}');
    } catch {
      value = {};
    }
  }
  const schema = contactConfigSchema(backend, kind);
  const parsed = schema.safeParse(value && typeof value === 'object' ? value : {});
  const data = parsed.success ? parsed.data : schema.parse({});
  return derivedDefaults(backend, data);
}

export function validateContactConfig(backend, kind, input) {
  const schema = contactConfigSchema(backend, kind);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return parsed;
  const data = derivedDefaults(backend, parsed.data);
  const issues = [];
  if (backend === 'api') {
    if (!data.model) issues.push({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model required' });
    if (!data.apiKey && !data.apiKeyRef) {
      issues.push({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: 'apiKey or apiKeyRef required' });
    }
  }
  if (kind === 'room' || backend === 'room') {
    if (!data.members?.length) {
      issues.push({ code: z.ZodIssueCode.custom, path: ['members'], message: 'at least one member required' });
    }
  }
  return issues.length
    ? { success: false, error: new z.ZodError(issues) }
    : { success: true, data };
}

export function formatContactConfigError(error) {
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}
