import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { CalendarConnectFailedError } from './calendar.exceptions.js';
import { requireCalendar } from './calendar.settings.js';

const TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  u: string;
  e: number;
}

/**
 * Names the member who started connecting. The callback also needs that
 * member's session, so somebody else's half-finished connection cannot land
 * on a victim's account: the state they would carry names somebody else.
 */
@Injectable()
export class CalendarStateService {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  issue(userId: string, now: number = Date.now()): string {
    const body = Buffer.from(
      JSON.stringify({ u: userId, e: now + TTL_MS } satisfies StatePayload),
    ).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verify(
    state: string | undefined,
    userId: string,
    now: number = Date.now(),
  ): void {
    const [body, signature, ...rest] = (state ?? '').split('.');
    if (!body || !signature || rest.length > 0) {
      throw new CalendarConnectFailedError('invalid_state');
    }
    if (!matches(signature, this.sign(body))) {
      throw new CalendarConnectFailedError('invalid_state');
    }
    const payload = decode(body);
    if (!payload || payload.u !== userId) {
      throw new CalendarConnectFailedError('invalid_state');
    }
    if (payload.e <= now) {
      throw new CalendarConnectFailedError('expired_state');
    }
  }

  // Prefixed, so a sign-in state signed with the same secret never passes.
  private sign(body: string): string {
    return createHmac('sha256', requireCalendar(this.config).stateSecret)
      .update(`calendar.${body}`)
      .digest('base64url');
  }
}

function decode(body: string): StatePayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    );
    const { u, e } = (parsed ?? {}) as Partial<StatePayload>;
    return typeof u === 'string' && typeof e === 'number' ? { u, e } : null;
  } catch {
    return null;
  }
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
