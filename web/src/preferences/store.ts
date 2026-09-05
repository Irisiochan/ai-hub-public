import { getThemeSnapshot, subscribeTheme } from '../theme/store.ts';

export type MotionLevel = 'off' | 'reduced' | 'full';
export type SoundCue = 'send' | 'assistant' | 'worker' | 'error';

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  cues: Record<SoundCue, boolean>;
}

export interface UiPreferenceSnapshot {
  motionOverride: MotionLevel | null;
  effectiveMotion: MotionLevel;
  systemReducedMotion: boolean;
  sound: SoundSettings;
}

const MOTION_KEY = 'ai-hub.motion.level.v1';
const SOUND_KEY = 'ai-hub.sound.settings.v1';

const DEFAULT_SOUND: SoundSettings = {
  enabled: true,
  volume: 0.45,
  cues: { send: true, assistant: true, worker: true, error: true },
};

let motionOverride: MotionLevel | null = null;
let systemReducedMotion = false;
let sound: SoundSettings = DEFAULT_SOUND;
let initialized = false;
let motionMedia: MediaQueryList | null = null;
let unsubscribeTheme: (() => void) | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function themeMotionDefault(): MotionLevel {
  const current = getThemeSnapshot().themes.find((theme) => theme.id === getThemeSnapshot().selectedId);
  return current?.animation === 'reduced' ? 'reduced' : 'full';
}

export function resolveMotionLevel(
  override: MotionLevel | null,
  prefersReduced: boolean,
  themeDefault: MotionLevel,
): MotionLevel {
  if (override) return override;
  return prefersReduced ? 'reduced' : themeDefault;
}

function snapshot(): UiPreferenceSnapshot {
  return {
    motionOverride,
    effectiveMotion: resolveMotionLevel(motionOverride, systemReducedMotion, themeMotionDefault()),
    systemReducedMotion,
    sound,
  };
}

let currentSnapshot = snapshot();

function applyMotion(level: MotionLevel): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motionLevel = level;
}

function refresh(emit = true): void {
  currentSnapshot = snapshot();
  applyMotion(currentSnapshot.effectiveMotion);
  if (emit) for (const listener of listeners) listener();
}

function parseSound(raw: string | null): SoundSettings {
  if (!raw) return DEFAULT_SOUND;
  try {
    const value = JSON.parse(raw) as Partial<SoundSettings>;
    const cues = (value.cues ?? {}) as Partial<Record<SoundCue, boolean>>;
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SOUND.enabled,
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume)
        ? Math.min(1, Math.max(0, value.volume))
        : DEFAULT_SOUND.volume,
      cues: {
        send: typeof cues.send === 'boolean' ? cues.send : true,
        assistant: typeof cues.assistant === 'boolean' ? cues.assistant : true,
        worker: typeof cues.worker === 'boolean' ? cues.worker : true,
        error: typeof cues.error === 'boolean' ? cues.error : true,
      },
    };
  } catch {
    return DEFAULT_SOUND;
  }
}

export function initializeUiPreferences(): void {
  if (initialized) return;
  initialized = true;
  const saved = storage();
  const savedMotion = saved?.getItem(MOTION_KEY);
  if (savedMotion === 'off' || savedMotion === 'reduced' || savedMotion === 'full') motionOverride = savedMotion;
  sound = parseSound(saved?.getItem(SOUND_KEY) ?? null);
  if (typeof matchMedia === 'function') {
    motionMedia = matchMedia('(prefers-reduced-motion: reduce)');
    systemReducedMotion = motionMedia.matches;
    motionMedia.addEventListener('change', (event) => {
      systemReducedMotion = event.matches;
      if (motionOverride === null) refresh();
    });
  }
  unsubscribeTheme = subscribeTheme(() => {
    if (motionOverride === null) refresh();
  });
  refresh(false);
}

export function subscribeUiPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUiPreferenceSnapshot(): UiPreferenceSnapshot {
  return currentSnapshot;
}

export function setMotionLevel(level: MotionLevel): void {
  motionOverride = level;
  storage()?.setItem(MOTION_KEY, level);
  refresh();
}

export function setSoundEnabled(enabled: boolean): void {
  setSoundSettings({ ...sound, enabled });
}

export function setSoundVolume(volume: number): void {
  setSoundSettings({ ...sound, volume: Math.min(1, Math.max(0, volume)) });
}

export function setSoundCueEnabled(cue: SoundCue, enabled: boolean): void {
  setSoundSettings({ ...sound, cues: { ...sound.cues, [cue]: enabled } });
}

function setSoundSettings(next: SoundSettings): void {
  sound = next;
  storage()?.setItem(SOUND_KEY, JSON.stringify(sound));
  refresh();
}

/** Test-only cleanup for Node's shared module process. */
export function resetUiPreferencesForTests(): void {
  motionMedia = null;
  unsubscribeTheme?.();
  unsubscribeTheme = null;
  initialized = false;
  motionOverride = null;
  systemReducedMotion = false;
  sound = DEFAULT_SOUND;
  currentSnapshot = snapshot();
  listeners.clear();
}
