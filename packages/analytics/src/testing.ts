import {
  analyticsOver,
  type Analytics,
  type CapturedEvent,
  type CohortProperties,
  type PersonProperties,
} from './analytics.js';

export interface TestAnalytics extends Analytics {
  /** What would have gone to PostHog, in order. */
  events: CapturedEvent[];
  people: { distinctId: string; properties: PersonProperties }[];
  cohorts: { cohortId: string; properties: CohortProperties }[];
  /** What was dropped, as `event: reason`. */
  dropped: string[];
}

/** The real validation, with a list where PostHog would be. */
export function createTestAnalytics(): TestAnalytics {
  const events: CapturedEvent[] = [];
  const people: TestAnalytics['people'] = [];
  const cohorts: TestAnalytics['cohorts'] = [];
  const dropped: string[] = [];
  const analytics = analyticsOver(
    {
      capture: (event) => events.push(event),
      identifyPerson: (distinctId, properties) =>
        people.push({ distinctId, properties }),
      identifyCohort: (cohortId, properties) =>
        cohorts.push({ cohortId, properties }),
      shutdown: async () => undefined,
    },
    {
      environment: 'test',
      release: 'test-release',
      onDropped: (event, reason) => dropped.push(`${event}: ${reason}`),
    },
  );
  return { ...analytics, events, people, cohorts, dropped };
}
