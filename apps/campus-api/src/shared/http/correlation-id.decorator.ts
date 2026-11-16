import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * The request's correlation id — the caller's x-correlation-id when it was
 * usable, otherwise generated; see resolveCorrelationId — for records that
 * should lead back to this request's log lines. Undefined outside an HTTP request.
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const req = context.switchToHttp().getRequest<{ id?: unknown }>();
    return typeof req.id === 'string' ? req.id : undefined;
  },
);
