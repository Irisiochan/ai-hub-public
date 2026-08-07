import type { z } from 'zod';

export type ContactBackend = 'claude-cli' | 'codex' | 'grok-cli' | 'api' | 'room';
export type ContactKind = 'dm' | 'room';
export type ApiProvider = 'anthropic' | 'openai-compat' | 'gemini';

export interface ContactMemoryConfig {
  injectOnSpawn?: boolean;
  searchPerTurn?: boolean;
  capture?: boolean;
  maxTurnChars?: number;
  sessionMaxAgeHours?: number;
  [key: string]: unknown;
}

export interface ProjectAccessConfig {
  enabled: boolean;
  workspace: string;
  allowShell: boolean;
  [key: string]: unknown;
}

export interface DelegationConfig {
  enabled: boolean;
  workspaces: string[];
  runners: Array<'claude' | 'codex' | 'grok'>;
  allowShell: boolean;
  allowSsh: boolean;
  workerId?: string;
  maxOpenJobs: number;
  [key: string]: unknown;
}

export interface RoutingConfig {
  enabled: boolean;
  recipientKey?: string;
  categories: string[];
  minPriority: 1 | 2 | 3;
  dailyLimit: number;
  cooldownMinutes: number;
  fallback: boolean;
  [key: string]: unknown;
}

export interface ContactConfig {
  cliPath?: string;
  cwd?: string;
  model: string;
  modelOptions: Array<string | { id: string; label?: string; [key: string]: unknown }>;
  effort: string;
  memory: ContactMemoryConfig;
  delegation: DelegationConfig;
  routing: RoutingConfig;
  projectAccess: ProjectAccessConfig;
  affect: 'on' | 'off';
  affectBaseline: { valence: number; arousal: number };
  maxSessionInputTokens: number;
  roomDeliveryMaxChars: number;
  roomDeliveryMaxMessages: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  permissionMode?: string;
  mcpConfig?: string;
  developerInstructions?: string;
  provider?: ApiProvider;
  baseUrl?: string;
  apiKey?: string;
  apiKeyRef?: string;
  visionModel?: string;
  supportsImages?: boolean;
  systemPrompt?: string;
  maxHistoryMessages?: number;
  historyTokenBudget?: number;
  minRecentTurns?: number;
  summaryMaxTokens?: number;
  historySummaryStrategy?: 'extractive' | 'off' | 'external';
  memoryPreambleMode?: 'full' | 'compact' | 'off';
  promptCache?: 'auto' | 'off';
  maxTokens?: number;
  contextWindowTokens?: number;
  members?: string[];
  reactionRounds?: number;
  respondAllByDefault?: boolean;
  [key: string]: unknown;
}

export const MemoryConfigSchema: z.ZodType<ContactMemoryConfig>;
export const ProjectAccessSchema: z.ZodType<ProjectAccessConfig>;
export const DelegationConfigSchema: z.ZodType<DelegationConfig>;
export const RoutingConfigSchema: z.ZodType<RoutingConfig>;
export const ClaudeContactConfigSchema: z.ZodType<ContactConfig>;
export const CodexContactConfigSchema: z.ZodType<ContactConfig>;
export const GrokContactConfigSchema: z.ZodType<ContactConfig>;
export const ApiContactConfigSchema: z.ZodType<ContactConfig>;
export const RoomContactConfigSchema: z.ZodType<ContactConfig>;
export const ContactConfigSchemas: Record<ContactBackend, z.ZodType<ContactConfig>>;

export function contactConfigSchema(backend: ContactBackend | string, kind?: ContactKind): z.ZodType<ContactConfig>;
export function parseStoredContactConfig(
  backend: ContactBackend | string,
  kind: ContactKind,
  raw: unknown
): ContactConfig;
export function validateContactConfig(
  backend: ContactBackend | string,
  kind: ContactKind,
  input: unknown
): z.SafeParseReturnType<unknown, ContactConfig>;
export function formatContactConfigError(error: z.ZodError): string;
