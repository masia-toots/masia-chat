import { frameworkErrorCode, RelayError, RelayErrorCode, RETRY_AFTER_DETAIL } from '@masia/relay';
import type { FastifyError, FastifyInstance } from 'fastify';

const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_MAX = 499;

/**
 * One error format for the whole API: `{ error: <stable code>, message, ...facts }`.
 *
 * Domain refusals (`RelayError`) keep their own status and facts (the current epoch, the current
 * list version), and a `retryAfterSeconds` fact also becomes the `Retry-After` header. A request
 * Fastify itself refuses keeps its 4xx, with the code the status table gives it (a body too large
 * is PAYLOAD_TOO_LARGE, not a validation failure). Anything else is a bug: it is logged
 * in full on the server and answered with a bare 500, because an internal message can name a
 * table, a query or a key and a client has no use for it.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof RelayError) {
      const retryAfterSeconds = error.details[RETRY_AFTER_DETAIL];
      if (typeof retryAfterSeconds === 'number') reply.header('Retry-After', retryAfterSeconds);
      return reply.code(error.statusCode).send(error.toBody());
    }

    const status = error.statusCode ?? 500;
    if (status >= CLIENT_ERROR_MIN && status <= CLIENT_ERROR_MAX) {
      return reply.code(status).send({ error: frameworkErrorCode(status), message: error.message });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: RelayErrorCode.INTERNAL, message: 'The relay failed to handle the request.' });
  });
}
