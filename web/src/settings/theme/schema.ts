import { z } from 'zod';

export const THEME_MANIFEST_VERSION = 1 as const;

const cssColor = z.string().max(64).refine(
  (value) => /^(?:#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|oklch\([0-9.%\s]+\))$/i.test(value),
  'must be a literal CSS color (hex, rgb, hsl, or oklch)',
);

const safeReference = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._/-]*$/i);

export const bubbleGradientSchema = z.object({
  enabled: z.boolean(),
  angle: z.number().int().min(0).max(360),
  from: cssColor,
  to: cssColor,
}).strict();

export const themeVariantSchema = z.object({
  primary: z.object({
    accent: cssColor,
    soft: cssColor,
    line: cssColor,
    glow: cssColor,
    ink: cssColor,
    text: cssColor,
  }).strict(),
  surfaces: z.object({
    background: cssColor,
    canvas: cssColor,
    panel: cssColor,
    rail: cssColor,
    elevated: cssColor,
    card: cssColor,
    hover: cssColor,
    raised: cssColor,
    code: cssColor,
  }).strict(),
  text: z.object({
    primary: cssColor,
    body: cssColor,
    dim: cssColor,
    muted: cssColor,
    onOutgoing: cssColor,
  }).strict(),
  borders: z.object({
    subtle: cssColor,
    strong: cssColor,
  }).strict(),
  bubbles: z.object({
    incoming: cssColor,
    outgoing: cssColor,
    incomingText: cssColor,
    outgoingText: cssColor,
    incomingGradient: bubbleGradientSchema,
    outgoingGradient: bubbleGradientSchema,
  }).strict(),
  wallpaper: z.object({
    asset: z.enum(['none', 'violet-bloom', 'quiet-grid']),
    background: cssColor,
    size: z.enum(['auto', '320px', '480px', '640px']),
  }).strict(),
  icons: z.object({
    default: cssColor,
    muted: cssColor,
    active: cssColor,
  }).strict(),
  status: z.object({
    success: cssColor,
    successSoft: cssColor,
    successLine: cssColor,
    successText: cssColor,
    error: cssColor,
    errorSoft: cssColor,
    errorLine: cssColor,
  }).strict(),
}).strict();

export const themeManifestSchema = z.object({
  version: z.literal(THEME_MANIFEST_VERSION),
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9.-]*$/),
  name: z.string().min(1).max(64),
  description: z.string().max(240),
  author: z.string().min(1).max(80),
  variants: z.object({
    light: themeVariantSchema,
    dark: themeVariantSchema,
  }).strict(),
  wallpaperAttribution: z.object({
    source: z.string().min(1).max(160),
    license: z.string().min(1).max(80),
  }).strict(),
  sounds: z.object({
    packId: safeReference.nullable(),
    incoming: safeReference.nullable(),
    outgoing: safeReference.nullable(),
  }).strict(),
  animation: z.enum(['reduced', 'standard', 'expressive']),
}).strict();

export const importedThemeListSchema = z.array(themeManifestSchema).max(20);

export type ThemeManifest = z.infer<typeof themeManifestSchema>;
export type ThemeVariant = z.infer<typeof themeVariantSchema>;
export type ThemeMode = 'light' | 'dark' | 'system';

export function parseThemeManifest(input: unknown): ThemeManifest {
  return themeManifestSchema.parse(input);
}

export function formatThemeValidationError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : '未知主题包错误';
  const first = error.issues[0];
  return `${first.path.join('.') || 'manifest'}: ${first.message}`;
}
