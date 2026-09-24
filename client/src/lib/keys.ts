/**
 * Input resolution: keyboard events and touch coordinates to actions.
 *
 * Kept out of the component because the core loop is the one place in the app
 * where latency is visible, and because "which key means what" is a setting
 * the user can rewrite. Answer bindings come from the device keymap; the
 * navigation keys below are fixed, so no keymap edit can leave someone unable
 * to reach settings.
 */

import type { ScaleName } from '@shared/scales.js';
import type { Keymap } from './device';

export type Action =
  | { kind: 'answer'; level: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'star' }
  | { kind: 'lists' }
  | { kind: 'reveal' }
  | { kind: 'settings' }
  | { kind: 'stats' }
  | { kind: 'close' };

/** Which keymap slots feed which scale, in level order. */
const SLOTS: Record<ScaleName, Array<keyof Keymap>> = {
  seen: ['seen'],
  binary: ['dontKnow', 'know'],
  graded: ['l1', 'l2', 'l3', 'l4'],
};

export function slotsFor(scale: ScaleName): Array<keyof Keymap> {
  return SLOTS[scale];
}

/** Normalised so 'F', 'f' and a shifted '/' all compare sensibly. */
function keyOf(event: KeyboardEvent): string {
  if (event.key === ' ' || event.code === 'Space') return ' ';
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function resolveKey(
  event: KeyboardEvent,
  scale: ScaleName,
  keymap: Keymap,
): Action | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = keyOf(event);

  switch (key) {
    // Left steps back to the previous word, right replays what was undone.
    // Fixed rather than rebindable so history navigation always works.
    case 'Backspace': case 'ArrowLeft': return { kind: 'undo' };
    case 'ArrowRight': return { kind: 'redo' };
    case 'Escape': return { kind: 'close' };
    case '/': case '?': return { kind: 'reveal' };
    default: break;
  }

  const slots = SLOTS[scale];
  for (let i = 0; i < slots.length; i++) {
    const bindings = keymap[slots[i]];
    if (bindings.some((binding) => binding.toLowerCase() === key.toLowerCase())) {
      return { kind: 'answer', level: i + 1 };
    }
  }

  // Space and Enter reveal the definition unless the active scale binds them
  // as answers (the `seen` scale uses Space). Checked after the answer keys so
  // a keymap may claim any of these; Escape and Backspace above always work.
  if (key === ' ' || key === 'Enter') return { kind: 'reveal' };
  if (key === 'f') return { kind: 'star' };
  if (key === 'l') return { kind: 'lists' };
  if (key === 's') return { kind: 'settings' };
  if (key === 't') return { kind: 'stats' };
  return null;
}

/** A horizontal swipe answers in `binary`: left is "don't know", right is "know". */
export const SWIPE_MIN_PX = 60;

export function prettyKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key.startsWith('Arrow')) return key.slice(5);
  return key.length === 1 ? key.toUpperCase() : key;
}
