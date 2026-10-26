import { Inject, Injectable } from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  STATE_TTL_MS,
  readState,
  signState,
} from '../../shared/auth/signed-state.js';
import { CalendarConnectFailedError } from './calendar.exceptions.js';
import { requireCalendar } from './calendar.settings.js';

interface StatePayload {
  u: string;
  e: number;
}

/** Signed apart from sign-in's states, which share the secret. */
const CONTEXT = 'calendar';

/**
 * Names the member who started connecting. The callback also needs that
 * member's session, so somebody else's half-finished connection cannot land
 * on a victim's account: the state they would carry names somebody else.
 */
@Injectable()
export class CalendarStateService {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  issue(userId: string, now: number = Date.now()): string {
    const payload: StatePayload = { u: userId, e: now + STATE_TTL_MS };
    return signState(this.secret, payload, CONTEXT);
  }

  verify(
    state: string | undefined,
    userId: string,
    now: number = Date.now(),
  ): void {
    const payload = readState(this.secret, state, CONTEXT);
    if (!isStatePayload(payload) || payload.u !== userId) {
      throw new CalendarConnectFailedError('invalid_state');
    }
    if (payload.e <= now) {
      throw new CalendarConnectFailedError('expired_state');
    }
  }

  private get secret(): string {
    return requireCalendar(this.config).stateSecret;
  }
}

function isStatePayload(value: unknown): value is StatePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StatePayload).u === 'string' &&
    typeof (value as StatePayload).e === 'number'
  );
}
