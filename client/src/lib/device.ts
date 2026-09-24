/**
 * Device-local settings and the recent-pace ring buffer.
 *
 * Deliberately outside the synced snapshot. A keymap, an input scheme and an
 * auto-advance timeout describe the machine in front of you, not the profile:
 * syncing them would push a phone's touch layout onto a desktop and a
 * desktop's keyboard bindings onto a phone. The rating scale and the sequence
 * *are* profile state, so those live in the container and do sync.
 */

import * as db from './db';

export type InputScheme = 'keys' | 'touch' | 'auto';
export type Theme = 'system' | 'dark' | 'light';

export interface Keymap {
  seen: string[];
  dontKnow: string[];
  know: string[];
  l1: string[];
  l2: string[];
  l3: string[];
  l4: string[];
}

export interface DeviceSettings {
  inputScheme: InputScheme;
  autoAdvanceMs: number;
  keymap: Keymap;
  /** Bumped when the default keymap changes, so stale defaults can be upgraded. */
  keymapVersion: number;
  theme: Theme;
}

/**
 * Numbers, left to right in the order the scale reads: 1 is always the
 * "don't know" end and the highest number the "know" end, whichever scale is
 * active. The same finger means the same thing on every scale.
 */
export const DEFAULT_KEYMAP: Keymap = {
  seen: ['1', ' '],
  dontKnow: ['1'],
  know: ['2'],
  l1: ['1'],
  l2: ['2'],
  l3: ['3'],
  l4: ['4'],
};

const KEYMAP_VERSION = 2;

/**
 * The version-1 default (F/J home row). A stored keymap identical to it was
 * never customised - it was saved alongside some other device setting - so it
 * is upgraded to the numeric default. Anything else is a real choice and kept.
 */
const LEGACY_DEFAULT_KEYMAP: Keymap = {
  seen: [' '],
  dontKnow: ['f', 'ArrowLeft'],
  know: ['j', 'ArrowRight'],
  l1: ['1', 'f'],
  l2: ['2', 'g'],
  l3: ['3', 'h'],
  l4: ['4', 'j'],
};

function resolveKeymap(stored: Partial<DeviceSettings> | undefined): Keymap {
  const saved = stored?.keymap;
  if (!saved) return structuredClone(DEFAULT_KEYMAP);
  if ((stored?.keymapVersion ?? 1) < KEYMAP_VERSION
    && JSON.stringify(saved) === JSON.stringify(LEGACY_DEFAULT_KEYMAP)) {
    return structuredClone(DEFAULT_KEYMAP);
  }
  return { ...structuredClone(DEFAULT_KEYMAP), ...saved };
}

export function defaultDeviceSettings(): DeviceSettings {
  const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
  return {
    inputScheme: fine ? 'keys' : 'touch',
    autoAdvanceMs: 0,
    keymap: structuredClone(DEFAULT_KEYMAP),
    keymapVersion: KEYMAP_VERSION,
    theme: 'system',
  };
}

/** Trailing window for the "recent pace" projection on the timing page. */
export const RECENT_MAX = 200;

export interface RecentEntry { id: number; durMs: number; }

let cached: DeviceSettings | null = null;
let recent: RecentEntry[] = [];

export async function loadDevice(): Promise<DeviceSettings> {
  if (cached) return cached;
  const stored = await db.get<Partial<DeviceSettings>>('state', 'device');
  const base = defaultDeviceSettings();
  cached = {
    inputScheme: ['keys', 'touch', 'auto'].includes(stored?.inputScheme as string)
      ? stored!.inputScheme as InputScheme : base.inputScheme,
    autoAdvanceMs: clampAdvance(stored?.autoAdvanceMs),
    keymap: resolveKeymap(stored),
    keymapVersion: KEYMAP_VERSION,
    theme: ['system', 'dark', 'light'].includes(stored?.theme as string)
      ? stored!.theme as Theme : base.theme,
  };
  recent = (await db.get<RecentEntry[]>('state', 'recent')) ?? [];
  return cached;
}

/** 0 is off; anything else is clamped into a range a human can actually use. */
function clampAdvance(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(20000, Math.max(300, Math.round(n)));
}

export function device(): DeviceSettings {
  if (!cached) throw new Error('device settings not loaded');
  return cached;
}

export async function saveDevice(patch: Partial<DeviceSettings>): Promise<DeviceSettings> {
  const next = { ...device(), ...patch };
  if (patch.autoAdvanceMs !== undefined) next.autoAdvanceMs = clampAdvance(patch.autoAdvanceMs);
  cached = next;
  await db.put('state', 'device', next);
  return next;
}

export function recentAnswers(): readonly RecentEntry[] {
  return recent;
}

let recentDirty = false;

export function pushRecent(entry: RecentEntry): void {
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
  recentDirty = true;
}

export async function flushRecent(): Promise<void> {
  if (!recentDirty) return;
  recentDirty = false;
  await db.put('state', 'recent', recent);
}
