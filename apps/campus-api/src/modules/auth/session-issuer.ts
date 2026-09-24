import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';

export type IssuedSession = Record<string, unknown>;

export abstract class SessionIssuer {
  abstract issueFullAccess(user: User): Promise<IssuedSession>;

  abstract issueProvisional(user: User, invite: Invite): Promise<IssuedSession>;
}

const PENDING_TICKET = 'Mint provisional token after Google redirect';

export class UnimplementedSessionIssuer extends SessionIssuer {
  issueFullAccess(): Promise<IssuedSession> {
    return Promise.reject(refusal('full access'));
  }

  issueProvisional(): Promise<IssuedSession> {
    return Promise.reject(refusal('provisional'));
  }
}

function refusal(kind: string): Error {
  return new Error(
    `Cannot issue a ${kind} session: token minting is not implemented yet (${PENDING_TICKET}).`,
  );
}
