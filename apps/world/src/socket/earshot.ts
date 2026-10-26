/** The longest `say`, in characters, once trimmed. */
export const MAX_SAY_LENGTH = 500;

/** How somebody's space carries a voice, and so a line of chat. */
export type Hearing = { kind: 'room' } | { kind: 'proximity'; radius: number };

export interface Standing {
  userId: string;
  spaceKey: string;
  x: number;
  y: number;
}

/**
 * Who hears a speaker: everybody else in the same space, and in a
 * proximity space only those within its radius, as for the space's call.
 */
export function inEarshot<T extends Standing>(
  speaker: Standing,
  others: readonly T[],
  hearing: Hearing,
): T[] {
  return others.filter(
    (other) =>
      other.userId !== speaker.userId &&
      other.spaceKey === speaker.spaceKey &&
      (hearing.kind === 'room' ||
        Math.hypot(other.x - speaker.x, other.y - speaker.y) <= hearing.radius),
  );
}

/** Five lines at once, then one a second. */
const BURST = 5;
const PER_SECOND = 1;

/**
 * How often one socket may `say`, well under the frame budget: chat lands
 * on other people's screens, so a flood is theirs to read, not only world's
 * to parse.
 */
export class SayBudget {
  private lines = BURST;
  private refilledAt: number;

  constructor(now: number) {
    this.refilledAt = now;
  }

  admit(now: number): boolean {
    const elapsed = Math.max(0, now - this.refilledAt);
    this.lines = Math.min(BURST, this.lines + (elapsed * PER_SECOND) / 1000);
    this.refilledAt = Math.max(this.refilledAt, now);
    if (this.lines < 1) return false;
    this.lines -= 1;
    return true;
  }
}
