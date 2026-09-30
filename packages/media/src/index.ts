/**
 * Room tokens for the media server (LiveKit), shared by whichever service
 * ends up minting them. Which one that is — campus-api or world — is still
 * an open decision; both can depend on this package, so it can be settled
 * without moving the code. LiveKit's own types stay inside this package.
 */
export * from './room-token.js';
