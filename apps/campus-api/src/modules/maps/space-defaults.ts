import {
  AudioMode,
  PublishPolicy,
  SpaceAccess,
  SpaceKind,
  type NewSpace,
} from './schema.js';

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

type Behaviour = Pick<NewSpace, 'audioMode' | 'access' | 'publishPolicy'>;

/**
 * How a space of each kind behaves when it is first met. A starting point
 * only: an admin changes any of it afterwards, and a sync never puts these
 * back.
 *
 * The thinking, kind by kind:
 * - `open`, `desk`, `notice_board`: you hear who is near you, and anybody on
 *   the campus may be there.
 * - `meeting_room`, `help_desk`: everybody in the room hears everybody, and
 *   anybody may walk in.
 * - `classroom`: the same audio, but for the cohort and not its guests.
 * - `mentor_pod`: the same audio, for the people it has been granted to.
 * - `live_coding`: staff speak to the room; for the cohort.
 * - `town_hall`: staff speak to the room; anybody may come.
 * - `stage`: only whoever has been given the floor speaks.
 */
const BY_KIND: Record<SpaceKind, Behaviour> = {
  [SpaceKind.Open]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.Desk]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.NoticeBoard]: {
    audioMode: AudioMode.Proximity,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.MeetingRoom]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.HelpDesk]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.Classroom]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Cohort,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.MentorPod]: {
    audioMode: AudioMode.Boundary,
    access: SpaceAccess.Invite,
    publishPolicy: PublishPolicy.All,
  },
  [SpaceKind.LiveCoding]: {
    audioMode: AudioMode.Broadcast,
    access: SpaceAccess.Cohort,
    publishPolicy: PublishPolicy.Staff,
  },
  [SpaceKind.TownHall]: {
    audioMode: AudioMode.Broadcast,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.Staff,
  },
  [SpaceKind.Stage]: {
    audioMode: AudioMode.Broadcast,
    access: SpaceAccess.Open,
    publishPolicy: PublishPolicy.GrantOnly,
  },
};

/**
 * A space with no kind is not set up, and admits nobody but admins whatever
 * it says here. It is given the most closed settings anyway, so that nothing
 * reading `access` on its own takes it for open.
 */
const NOT_SET_UP: Behaviour = {
  audioMode: AudioMode.Proximity,
  access: SpaceAccess.Invite,
  publishPolicy: PublishPolicy.All,
};

/** The settings a space of this kind starts with. */
export function defaultsFor(kind: SpaceKind | null): Behaviour {
  return kind ? BY_KIND[kind] : NOT_SET_UP;
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
