/**
 * The session token, shared by the two services that both have to understand
 * it: campus-api mints and verifies it, world verifies it on socket upgrade.
 * One copy, because two copies of claim-checking drift the moment the claims
 * change — and the drift shows up as a security hole, not a type error.
 */
export * from './session-token.js';
export * from './session-policy.js';
// The other thing both services read off an account: its system role.
export * from './system-role.js';
