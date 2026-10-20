/**
 * What campus-api and world must both answer the same way about a space:
 * whether a person may enter it. Defined once, for the reason everything
 * cross-service in this workspace is — two copies of a rule that decides who
 * gets in would drift, and the drift would open a door rather than fail a
 * build. A rule only one service needs belongs in that service.
 */
export * from './space-access.js';
