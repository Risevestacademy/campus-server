/**
 * What campus-api and world must agree on, defined once. It began with the
 * session token, which both have to understand: campus-api mints and
 * verifies it, world verifies it on socket upgrade. One copy, because two
 * copies of claim-checking drift the moment the claims change — and the drift
 * shows up as a security hole, not a type error. The same holds for each
 * rule exported below. A rule only one service needs belongs in that service.
 */
export * from './session-token.js';
export * from './session-policy.js';
// The other thing both services read off an account: its system role.
export * from './system-role.js';
// And what both draw somebody as: their sprite, and where a change is announced.
export * from './profile.js';
// And the one space both know of that no map draws.
export * from './spaces.js';
