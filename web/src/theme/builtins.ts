import type { ThemeManifest, ThemeVariant } from './schema.ts';

const irisDark: ThemeVariant = {
  primary: {
    accent: '#9d8cf5', soft: 'rgba(157, 140, 245, 0.14)', line: 'rgba(157, 140, 245, 0.4)', glow: 'rgba(157, 140, 245, 0.25)',
    ink: '#0d0a1a', text: '#c3b6fb',
  },
  surfaces: {
    background: '#0d0e13', canvas: '#0d0e13', panel: '#0f1117', rail: '#101219',
    elevated: '#111319', card: '#141620', hover: '#171a23', raised: '#1e2130', code: '#0a0b10',
  },
  text: { primary: '#e8e8ee', body: '#dfe0e8', dim: '#8b8c99', muted: '#63646f', onOutgoing: '#f8f6ff' },
  borders: { subtle: 'rgba(255, 255, 255, 0.06)', strong: 'rgba(255, 255, 255, 0.1)' },
  bubbles: {
    incoming: '#151821', outgoing: '#4a3f78', incomingText: '#dfe0e8', outgoingText: '#f8f6ff',
    incomingGradient: { enabled: false, angle: 145, from: '#151821', to: '#151821' },
    outgoingGradient: { enabled: false, angle: 145, from: '#4a3f78', to: '#4a3f78' },
  },
  wallpaper: { asset: 'violet-bloom', background: '#0d0e13', size: '480px' },
  icons: { default: '#c9cad4', muted: '#8b8c99', active: '#c3b6fb' },
  status: {
    success: '#6fd39a', successSoft: 'rgba(111, 211, 154, 0.12)',
    successLine: 'rgba(111, 211, 154, 0.22)', successText: '#8fd6b0',
    error: '#e56a6a', errorSoft: 'rgba(229, 90, 90, 0.12)', errorLine: 'rgba(229, 90, 90, 0.32)',
  },
};

const irisLight: ThemeVariant = {
  primary: {
    accent: '#7562d8', soft: 'rgba(117, 98, 216, 0.12)', line: 'rgba(117, 98, 216, 0.38)', glow: 'rgba(117, 98, 216, 0.22)',
    ink: '#ffffff', text: '#6553c3',
  },
  surfaces: {
    background: '#f2f0f8', canvas: '#f7f5fb', panel: '#ffffff', rail: '#f4f1fa',
    elevated: '#ffffff', card: '#f9f7fc', hover: '#eeeaf7', raised: '#e7e1f2', code: '#23202d',
  },
  text: { primary: '#25212f', body: '#34303f', dim: '#6f687d', muted: '#91899e', onOutgoing: '#ffffff' },
  borders: { subtle: 'rgba(45, 32, 68, 0.08)', strong: 'rgba(45, 32, 68, 0.15)' },
  bubbles: {
    incoming: '#ffffff', outgoing: '#7562d8', incomingText: '#34303f', outgoingText: '#ffffff',
    incomingGradient: { enabled: false, angle: 145, from: '#ffffff', to: '#ffffff' },
    outgoingGradient: { enabled: false, angle: 145, from: '#7562d8', to: '#7562d8' },
  },
  wallpaper: { asset: 'violet-bloom', background: '#f7f5fb', size: '480px' },
  icons: { default: '#514a5d', muted: '#777080', active: '#6553c3' },
  status: {
    success: '#2f9d64', successSoft: 'rgba(47, 157, 100, 0.1)',
    successLine: 'rgba(47, 157, 100, 0.24)', successText: '#247c50',
    error: '#c94855', errorSoft: 'rgba(201, 72, 85, 0.1)', errorLine: 'rgba(201, 72, 85, 0.28)',
  },
};

const mintDark: ThemeVariant = {
  primary: {
    accent: '#65c9ad', soft: 'rgba(101, 201, 173, 0.13)', line: 'rgba(101, 201, 173, 0.38)', glow: 'rgba(101, 201, 173, 0.22)',
    ink: '#071511', text: '#8edac4',
  },
  surfaces: {
    background: '#0b1212', canvas: '#0b1212', panel: '#0d1615', rail: '#0e1817',
    elevated: '#111c1a', card: '#14201e', hover: '#182724', raised: '#20312e', code: '#08100f',
  },
  text: { primary: '#e4eeeb', body: '#d8e5e1', dim: '#879a94', muted: '#61736d', onOutgoing: '#f4fffb' },
  borders: { subtle: 'rgba(224, 255, 246, 0.06)', strong: 'rgba(224, 255, 246, 0.11)' },
  bubbles: {
    incoming: '#13201e', outgoing: '#285f55', incomingText: '#d8e5e1', outgoingText: '#f4fffb',
    incomingGradient: { enabled: false, angle: 145, from: '#13201e', to: '#13201e' },
    outgoingGradient: { enabled: true, angle: 145, from: '#285f55', to: '#31506b' },
  },
  wallpaper: { asset: 'quiet-grid', background: '#0b1212', size: '320px' },
  icons: { default: '#c6d5d0', muted: '#879a94', active: '#8edac4' },
  status: {
    success: '#65c9ad', successSoft: 'rgba(101, 201, 173, 0.12)',
    successLine: 'rgba(101, 201, 173, 0.24)', successText: '#8edac4',
    error: '#e27878', errorSoft: 'rgba(226, 120, 120, 0.12)', errorLine: 'rgba(226, 120, 120, 0.3)',
  },
};

const mintLight: ThemeVariant = {
  primary: {
    accent: '#2e9279', soft: 'rgba(46, 146, 121, 0.11)', line: 'rgba(46, 146, 121, 0.34)', glow: 'rgba(46, 146, 121, 0.2)',
    ink: '#ffffff', text: '#277d69',
  },
  surfaces: {
    background: '#edf5f2', canvas: '#f4f8f7', panel: '#ffffff', rail: '#eef6f3',
    elevated: '#ffffff', card: '#f5faf8', hover: '#e6f1ed', raised: '#dcebe6', code: '#172421',
  },
  text: { primary: '#1e2d29', body: '#2e3d39', dim: '#667873', muted: '#879792', onOutgoing: '#ffffff' },
  borders: { subtle: 'rgba(20, 65, 53, 0.08)', strong: 'rgba(20, 65, 53, 0.15)' },
  bubbles: {
    incoming: '#ffffff', outgoing: '#2e9279', incomingText: '#2e3d39', outgoingText: '#ffffff',
    incomingGradient: { enabled: false, angle: 145, from: '#ffffff', to: '#ffffff' },
    outgoingGradient: { enabled: true, angle: 145, from: '#2e9279', to: '#3f7898' },
  },
  wallpaper: { asset: 'quiet-grid', background: '#f4f8f7', size: '320px' },
  icons: { default: '#40534e', muted: '#71837e', active: '#277d69' },
  status: {
    success: '#2e9279', successSoft: 'rgba(46, 146, 121, 0.1)',
    successLine: 'rgba(46, 146, 121, 0.23)', successText: '#277d69',
    error: '#c84f58', errorSoft: 'rgba(200, 79, 88, 0.1)', errorLine: 'rgba(200, 79, 88, 0.28)',
  },
};

export const VIOLET_PURPLE_THEME: ThemeManifest = {
  version: 1,
  id: 'violet-purple',
  name: 'Violet',
  description: 'AI Hub 的默认身份主题：克制的紫罗兰、低对比花瓣壁纸。',
  author: 'AI Hub',
  variants: { light: irisLight, dark: irisDark },
  wallpaperAttribution: { source: 'AI Hub 原创 SVG 图案', license: 'MIT' },
  sounds: { packId: 'builtin-synth', incoming: 'assistant', outgoing: 'send' },
  animation: 'standard',
};

export const QUIET_MINT_THEME: ThemeManifest = {
  version: 1,
  id: 'quiet-mint',
  name: '静谧薄荷',
  description: '低饱和青绿主题，用于验证非默认主题与渐变气泡路径。',
  author: 'AI Hub',
  variants: { light: mintLight, dark: mintDark },
  wallpaperAttribution: { source: 'AI Hub 原创 SVG 图案', license: 'MIT' },
  sounds: { packId: 'builtin-synth', incoming: 'assistant', outgoing: 'send' },
  animation: 'reduced',
};

export const BUILTIN_THEMES = [VIOLET_PURPLE_THEME, QUIET_MINT_THEME] as const;
export const DEFAULT_THEME_ID = VIOLET_PURPLE_THEME.id;
