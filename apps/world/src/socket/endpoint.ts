/**
 * Where the socket is and what an upgrade has to bring. Named once: the
 * gateway and the authentication enforce these, and the AsyncAPI document
 * tells clients about them, so the two cannot come to disagree.
 */

/** The route the socket is opened on. */
export const SOCKET_PATH = '/socket';

/** The query parameter naming the cohort being entered. */
export const COHORT_QUERY_PARAM = 'cohortId';

/** The cookie campus-api sets at sign-in, which the browser sends on the upgrade. */
export const SESSION_COOKIE = 'campus_session';
