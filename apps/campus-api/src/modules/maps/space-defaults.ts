import { CohortRole } from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, SpaceKind, type NewSpace } from './schema.js';

/** What the default space is called until an admin calls it something else. */
export const DEFAULT_SPACE_NAME = 'Corridors and grounds';

/**
 * The kinds the campus has one of, wherever it is. The database refuses a
 * second (`spaces_single_town_hall`, `spaces_single_notice_board`), so the
 * sync must not hand a second space the kind just because the map suggests
 * it.
 */
export const SINGLETON_KINDS: ReadonlySet<SpaceKind> = new Set([
  SpaceKind.TownHall,
  SpaceKind.NoticeBoard,
]);

type Behaviour = Pick<NewSpace, 'audioMode' | 'access'>;

/**
 * How a space of each kind behaves when it is first met. A starting point
 * only: an admin changes any of it afterwards, and a sync never puts these
 * back.
 *
 * The thinking, kind by kind:
 * - `open`, `desk`, `notice_board`: you hear who is near you, and anybody on
 *   the campus may be there.
 * - `meeting_room`, `help_desk`, `town_hall`, `stage`: everybody in the room
 *   hears everybody, and anybody may walk in.
 * - `classroom`, `live_coding`: the same audio, for the cohort's students,
 *   professors and mentors (STARTING_LISTS) and not its guests.
 * - `mentor_pod`: the same audio, for whoever an admin puts on its list.
 */
const BY_KIND: Record<SpaceKind, Behaviour> = {
  [SpaceKind.Open]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.Desk]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.NoticeBoard]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.MeetingRoom]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.HelpDesk]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.TownHall]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.Stage]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Normal,
  },
  [SpaceKind.Classroom]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Designated,
  },
  [SpaceKind.LiveCoding]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Designated,
  },
  [SpaceKind.MentorPod]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Designated,
  },
};

/**
 * The cohort roles a designated space of each kind starts with on its list.
 * The people the old `cohort` setting let in, which is everybody in the
 * cohort but its guests. A kind not here starts with an empty list: admins
 * only, until an admin adds somebody.
 */
const STARTING_LISTS: Partial<Record<SpaceKind, readonly CohortRole[]>> = {
  [SpaceKind.Classroom]: [
    CohortRole.Student,
    CohortRole.Professor,
    CohortRole.Mentor,
  ],
  [SpaceKind.LiveCoding]: [
    CohortRole.Student,
    CohortRole.Professor,
    CohortRole.Mentor,
  ],
};

/**
 * A space with no kind is not set up, and admits nobody but admins whatever
 * it says here. It is given the most closed settings anyway, designated with
 * an empty list, so that nothing reading `access` on its own takes it for
 * open.
 */
const NOT_SET_UP: Behaviour = {
  audioMode: AudioMode.Proximity,
  access: SpaceAccess.Designated,
};

/** The settings a space of this kind starts with. */
export function defaultsFor(kind: SpaceKind | null): Behaviour {
  return kind ? BY_KIND[kind] : NOT_SET_UP;
}

/** The cohort roles a new space of this kind starts with on its list. */
export function startingListFor(kind: SpaceKind | null): readonly CohortRole[] {
  return (kind && STARTING_LISTS[kind]) ?? [];
}

const KINDS = new Set<string>(Object.values(SpaceKind));

/**
 * The kind a map suggests for a space, if it suggests one this knows. The
 * suggestion is the class the designer gave the object in Tiled, which is a
 * rough label and may be blank, misspelt or something the campus has no
 * rules for. Anything else is no suggestion.
 */
export function suggestedKind(tiledClass: string | null): SpaceKind | null {
  const normalised = tiledClass
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return normalised && KINDS.has(normalised) ? (normalised as SpaceKind) : null;
}
