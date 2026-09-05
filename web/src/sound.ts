import { getUiPreferenceSnapshot, type SoundCue } from './preferences/store.ts';

const RECENT_EVENTS_KEY = 'ai-hub.sound.events.v1';
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const SEND_THROTTLE_MS = 300;
const MAX_RECENT_EVENTS = 160;

interface RecentSoundEvent {
  id: string;
  at: number;
}

interface ToneStep {
  type: OscillatorType;
  startHz: number;
  endHz: number;
  offset: number;
  duration: number;
  gain: number;
}

export interface SoundEventContext {
  currentConversation: boolean;
  pageVisible: boolean;
}

const TONES: Record<SoundCue, ToneStep[]> = {
  send: [{ type: 'sine', startHz: 340, endHz: 520, offset: 0, duration: 0.12, gain: 0.18 }],
  assistant: [
    { type: 'sine', startHz: 620, endHz: 690, offset: 0, duration: 0.11, gain: 0.4 },
    { type: 'sine', startHz: 820, endHz: 900, offset: 0.09, duration: 0.11, gain: 0.32 },
  ],
  worker: [
    { type: 'triangle', startHz: 440, endHz: 520, offset: 0, duration: 0.2, gain: 0.32 },
    { type: 'sine', startHz: 660, endHz: 780, offset: 0.03, duration: 0.19, gain: 0.25 },
  ],
  error: [{ type: 'sine', startHz: 300, endHz: 210, offset: 0, duration: 0.22, gain: 0.38 }],
};

let context: AudioContext | null = null;
let unlocked = false;
let listenersInstalled = false;
let lastSendAt = -Infinity;
const memoryEvents = new Map<string, number>();

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

async function unlock(): Promise<void> {
  const Constructor = audioContextConstructor();
  if (!Constructor) return;
  try {
    context ??= new Constructor();
    if (context.state === 'suspended') await context.resume();
    unlocked = context.state === 'running';
  } catch {
    // Autoplay denial is expected before a browser-trusted gesture; stay silent.
  }
}

export function initializeSoundSystem(): void {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  const onInteraction = () => { void unlock(); };
  document.addEventListener('pointerdown', onInteraction, { capture: true, passive: true });
  document.addEventListener('keydown', onInteraction, { capture: true });
}

function recentStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function claimEvent(eventId: string, now: number): boolean {
  const saved = recentStorage();
  let events: RecentSoundEvent[] = [];
  if (saved) {
    try {
      const parsed = JSON.parse(saved.getItem(RECENT_EVENTS_KEY) ?? '[]') as unknown;
      events = Array.isArray(parsed) ? parsed as RecentSoundEvent[] : [];
    } catch {
      events = [];
    }
  } else {
    events = [...memoryEvents].map(([id, at]) => ({ id, at }));
  }
  events = events.filter((event) => typeof event.id === 'string' && now - event.at < EVENT_TTL_MS);
  if (events.some((event) => event.id === eventId)) return false;
  events.push({ id: eventId, at: now });
  events = events.slice(-MAX_RECENT_EVENTS);
  if (saved) {
    try {
      saved.setItem(RECENT_EVENTS_KEY, JSON.stringify(events));
    } catch {
      // In-memory dedupe still protects this tab when storage is unavailable.
    }
  }
  memoryEvents.clear();
  for (const event of events) memoryEvents.set(event.id, event.at);
  return true;
}

function synthesize(cue: SoundCue, volume: number): boolean {
  if (!unlocked || !context || context.state !== 'running') return false;
  const now = context.currentTime;
  for (const step of TONES[cue]) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const start = now + step.offset;
    const end = start + step.duration;
    oscillator.type = step.type;
    oscillator.frequency.setValueAtTime(step.startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(step.endHz, end);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, step.gain * volume), start + 0.018);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
  }
  return true;
}

async function withCrossTabClaim(eventId: string, action: () => boolean): Promise<boolean> {
  const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (lockManager) {
    return lockManager.request(`ai-hub-sound:${eventId}`, { ifAvailable: true }, (lock) => {
      if (!lock || !claimEvent(eventId, Date.now())) return false;
      return action();
    }).catch(() => claimEvent(eventId, Date.now()) ? action() : false);
  }
  return claimEvent(eventId, Date.now()) ? action() : false;
}

/**
 * Plays one semantic event at most once across reconnects, history reconciliation,
 * and Chromium tabs. Callers supply visibility via document.visibilityState and
 * whether the event belongs to the currently selected conversation.
 */
export async function playSoundEvent(
  cue: SoundCue,
  eventId: string,
  eventContext: SoundEventContext,
): Promise<boolean> {
  return withCrossTabClaim(eventId, () => {
    const settings = getUiPreferenceSnapshot().sound;
    if (!settings.enabled || !settings.cues[cue]) return false;
    const now = performance.now();
    if (cue === 'send') {
      if (now - lastSendAt < SEND_THROTTLE_MS) return false;
      lastSendAt = now;
    }
    const attentionGain = eventContext.currentConversation && eventContext.pageVisible ? 1 : 0.82;
    return synthesize(cue, settings.volume * attentionGain);
  });
}

export async function previewSounds(): Promise<boolean> {
  await unlock();
  const settings = getUiPreferenceSnapshot().sound;
  if (!settings.enabled || !unlocked) return false;
  const cues: SoundCue[] = ['send', 'assistant', 'worker', 'error'];
  for (const [index, cue] of cues.entries()) {
    window.setTimeout(() => synthesize(cue, settings.volume), index * 340);
  }
  return true;
}

export const soundTiming = {
  maxCueMilliseconds: Math.max(...Object.values(TONES).flatMap((steps) => steps.map((step) => (step.offset + step.duration) * 1000))),
  sendThrottleMilliseconds: SEND_THROTTLE_MS,
  sendRelativeGain: TONES.send[0].gain / Math.max(...Object.values(TONES).flatMap((steps) => steps.map((step) => step.gain))),
};
