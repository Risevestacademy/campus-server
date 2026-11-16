import { EVENTS } from '@campus/analytics';

import {
  CohortRole,
  CohortStatus,
  StudentStatus,
} from '../../modules/cohorts/schema.js';
import { FeedbackType } from '../../modules/feedback/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
} from '../../modules/maps/schema.js';

const SPACE_ID = '22222222-2222-4222-8222-222222222222';

/** The package keeps its own lists, so they must keep up with the API's. */
describe("the analytics catalogue against the API's enums", () => {
  it.each(Object.values(CohortRole))('admits the cohort role %s', (role) => {
    expect(EVENTS['invite.revoked'].schema.safeParse({ role }).success).toBe(
      true,
    );
  });

  it.each(Object.values(CohortStatus))(
    'admits the cohort status %s',
    (status) => {
      expect(
        EVENTS['cohort.created'].schema.safeParse({ status }).success,
      ).toBe(true);
    },
  );

  it.each(Object.values(StudentStatus))(
    'admits the member status %s',
    (status) => {
      expect(
        EVENTS['member.status_changed'].schema.safeParse({
          from: status,
          to: status,
          subject_user_id: '11111111-1111-4111-8111-111111111111',
        }).success,
      ).toBe(true);
    },
  );

  it.each(Object.values(FeedbackType))(
    'admits the feedback type %s',
    (category) => {
      expect(
        EVENTS['feedback.submitted'].schema.safeParse({ category }).success,
      ).toBe(true);
    },
  );

  it.each(Object.values(SpaceKind))('admits the space kind %s', (kind) => {
    expect(
      EVENTS['staff.acted'].schema.safeParse({
        action: 'muted',
        space_kind: kind,
        actor_role: 'admin',
      }).success,
    ).toBe(true);
  });

  it.each(
    Object.values(SpaceAccess).flatMap((access) =>
      Object.values(AudioMode).map((audio) => [access, audio]),
    ),
  )('admits a %s space heard by %s', (access, audio_mode) => {
    expect(
      EVENTS['space.visited'].schema.safeParse({
        space_id: SPACE_ID,
        space_kind: SpaceKind.Open,
        access,
        audio_mode,
        duration_s: 0,
        arrived_by: 'step',
        lines_said: 0,
      }).success,
    ).toBe(true);
  });
});
