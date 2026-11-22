import {
  CALL_ACCEPTED_IDLE_MS,
  CALL_DEVICE_RECHECK_MS,
  CALL_ID_PATTERN,
  CALL_RELAY_LIMITS,
  CALL_RELAY_PATH,
  CALL_STREAM_EVENT,
  CALL_STREAM_MAX_LIFETIME_MS,
  CALL_STREAMS_FULL_RETRY_AFTER_SECONDS,
  CALL_TALLY_IDLE_MS,
  CallStreamsFullError,
  type CallStreamSink,
  parseRelayCallSignal,
  RateLimitedError,
  RELAY_CALL_SIGNAL,
  RelayError,
  RelayErrorCode,
  retryAfterSeconds,
  SSE_KEEP_ALIVE,
  sseEvent,
} from '@masia/relay';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AuthHook, principalOf, tokenExpiryOf } from '../auth.js';
import { requireCallingDevice, requireCallTarget, stillCallingDevice } from '../domain/call-parties.js';
import type { RouteDeps } from './route-deps.js';
import { errorResponses, idSchema, SECURITY } from './schemas.js';

const TAG = 'calls';
const ACCEPTED = 202;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** The longest delay a Node timer takes; anything longer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How long an open stream waits between keep-alives and between asks "is this device still allowed". */
export interface CallStreamTimings {
  readonly keepAliveMs: number;
  readonly deviceRecheckMs: number;
}

export const DEFAULT_CALL_STREAM_TIMINGS: CallStreamTimings = {
  keepAliveMs: CALL_RELAY_LIMITS.keepAliveMs,
  deviceRecheckMs: CALL_DEVICE_RECHECK_MS,
};

interface CallSignalBody {
  readonly conversationId: string;
  readonly toDeviceId: string;
  readonly signal: unknown;
}

const OPERATOR_SEES =
  'The relay cannot hear a call, but it sees who signals whom and when, both devices\' addresses and every SDP; ' +
  'it applies no blocks, quiet hours or child rules. Meant for loopback or a trusted LAN.';

/**
 * The call channel (ADR-228): instant, never stored signalling for a 1:1 audio call between the two people of a
 * one-to-one room. Registered only when the relay is configured with `RELAY_CALLS_ENABLED` (config.ts): off, these
 * routes do not exist.
 *
 * The rules of who may signal whom are `domain/call-parties.ts`; the streams and the budgets are `CallChannel`
 * (`@masia/relay`). Nothing here touches a table but to read; no body is logged.
 */
export function registerCallRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  timings: CallStreamTimings = DEFAULT_CALL_STREAM_TIMINGS,
): void {
  const { auth, db, calls, now } = deps;

  // An open stream keeps its connection busy, so the server could not close while one is open: end them all first.
  app.addHook('preClose', (done) => {
    calls.closeAll();
    done();
  });

  // The frame budget is spent right after the token is verified and before any database read: a sender past it costs
  // the relay a signature check and nothing more. It is keyed on both signed claims, the token's user and device, so a
  // valid token of another account that names a victim's device spends its own budget, never the victim's.
  const admitFrame: AuthHook = async (request: FastifyRequest) => {
    const { userId, deviceId } = principalOf(request);
    const admission = calls.admit({ userId, deviceId });
    if (!admission.ok) {
      throw new RateLimitedError(
        RelayErrorCode.ACTOR_RATE_LIMITED,
        'This device is sending call frames too fast; slow down.',
        Math.max(1, Math.ceil(admission.retryAfterMs / MS_PER_SECOND)),
      );
    }
  };
  const onRequest = [auth.authenticate, admitFrame, auth.checkActiveDevice];

  app.get(
    CALL_RELAY_PATH.STREAM,
    {
      onRequest,
      schema: {
        operationId: 'getCallStream',
        tags: [TAG],
        summary: "This device's stream of call signals (server-sent events)",
        description:
          'Only when the relay runs with RELAY_CALLS_ENABLED. A `text/event-stream` for a USER device (403 ' +
          'CALL_NOT_ALLOWED otherwise): first `event: ready` with `{closesInMs}` (the stream closes when the token ' +
          'expires: open the next one, with a fresh token, before), then `event: signal` with `{conversationId, ' +
          'fromUserId, fromDeviceId, signal}` for every signal posted to this device, and a comment line about every ' +
          `${CALL_RELAY_LIMITS.keepAliveMs / MS_PER_SECOND} s. One stream per device: a new one ends the old one ` +
          'with `event: replaced`. The device is checked again while the stream is open; revoked, it is closed. ' +
          'Nothing is stored or queued: a signal for a device with no open stream is gone. Token in the ' +
          `Authorization header only. ${OPERATOR_SEES}`,
        security: SECURITY,
        response: {
          200: {
            description: 'The stream (`text/event-stream`), open until the token expires or the device is replaced.',
            type: 'string',
          },
          ...errorResponses(429),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const device = await requireCallingDevice(db, principal);
      // Tokens live on the real clock (server.ts): so does the stream's end. `tokenExpiryOf` is bounded by the token's
      // own lifetime (auth.ts); the stream is bounded again here, so its timer never rests on one check alone.
      const closesInMs = Math.min(tokenExpiryOf(request) - Date.now(), CALL_STREAM_MAX_LIFETIME_MS, MAX_TIMER_MS);
      if (closesInMs <= 0) {
        throw new RelayError(RelayErrorCode.UNAUTHENTICATED, 'A valid bearer token is required.');
      }

      const raw = reply.raw;
      let closed = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      let release: () => void = () => undefined;

      const write = (frame: string): void => {
        if (!closed) raw.write(frame);
      };
      const cleanup = (): void => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        release();
      };
      const finish = (): void => {
        if (closed) return;
        cleanup();
        raw.end();
      };
      const sink: CallStreamSink = {
        get bufferedBytes() {
          return raw.writableLength;
        },
        write,
        end(reason) {
          if (reason === 'replaced') write(sseEvent(CALL_STREAM_EVENT.REPLACED, {}));
          finish();
        },
      };

      const opening = calls.openStream({ deviceId: device.id, userId: device.userId }, sink);
      if (!opening.ok) throw new CallStreamsFullError(CALL_STREAMS_FULL_RETRY_AFTER_SECONDS);
      release = opening.release;

      reply.hijack();
      // What the root hooks set (CORS) would otherwise be lost: a hijacked reply writes its own head.
      const head: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) head[name] = value;
      }
      raw.writeHead(200, {
        ...head,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      raw.on('close', cleanup);
      raw.on('error', cleanup);
      // The client may have gone while its device was being read: then no close event is left to come.
      if (raw.destroyed) {
        cleanup();
        return;
      }
      write(sseEvent(CALL_STREAM_EVENT.READY, { closesInMs }));

      timers.push(setInterval(() => write(SSE_KEEP_ALIVE), timings.keepAliveMs));
      timers.push(setTimeout(finish, closesInMs));
      timers.push(
        setInterval(() => {
          // A device revoked (or no longer a USER device) loses its stream; so does one the relay cannot check.
          stillCallingDevice(db, device).then(
            (ok) => {
              if (!ok) finish();
            },
            () => finish(),
          );
        }, timings.deviceRecheckMs),
      );
    },
  );

  app.post<{ Body: CallSignalBody }>(
    CALL_RELAY_PATH.SIGNAL,
    {
      onRequest,
      bodyLimit: CALL_RELAY_LIMITS.signalBodyMaxBytes,
      schema: {
        operationId: 'postCallSignal',
        tags: [TAG],
        summary: 'Hand one call signal to one device of the other person, now',
        description:
          'Only when the relay runs with RELAY_CALLS_ENABLED. The sender is the token\'s device and must be a USER ' +
          'device and a current member of the room (403 NOT_A_MEMBER or REMOVED); the room\'s current members must be ' +
          'USER devices of exactly two people and `toDeviceId` one of the other person\'s (403 CALL_NOT_ALLOWED). ' +
          '`signal` is a peer call signal (`call:ring`, `call:accept`, `call:accepted`, `call:decline`, `call:ice`, ' +
          '`call:verify`, `call:end`), checked for shape only (400 VALIDATION_FAILED). The receiver sees the sender ' +
          'as the relay knows it (`fromUserId`, `fromDeviceId`), never as the body says. 202 with an empty body, the ' +
          'same whether the target has an open stream or not: nothing is stored or queued. A device sends at most a ' +
          'burst of frames, then a few per second (429 ACTOR_RATE_LIMITED); calls a person places, and calls to one ' +
          'person, are capped per hour by call (429 ACTOR_RATE_LIMITED, TARGET_RATE_LIMITED). A ring that passes ' +
          'admits its call between the ringing device and the rung one; any other signal passes only between the two ' +
          `devices of an admitted call. An admitted call is forgotten after ${CALL_TALLY_IDLE_MS / MS_PER_MINUTE} ` +
          'minutes without a signal; once connected (`call:accept` from the rung device, then `call:accepted` from ' +
          `the ringing one), after ${CALL_ACCEPTED_IDLE_MS / MS_PER_HOUR} hours; and at once after a \`call:end\` ` +
          'either way, which itself is still delivered. Signals outside an admitted call, over a call\'s caps, or for ' +
          `a reader that has fallen behind are dropped, still 202. ${OPERATOR_SEES}`,
        security: SECURITY,
        body: {
          type: 'object',
          properties: {
            conversationId: idSchema,
            toDeviceId: idSchema,
            signal: {
              type: 'object',
              description: 'A peer call signal; validated in full by the relay (unknown fields are dropped).',
              properties: {
                type: {
                  type: 'string',
                  enum: Object.values(RELAY_CALL_SIGNAL),
                },
                callId: { type: 'string', pattern: CALL_ID_PATTERN.source },
              },
              required: ['type', 'callId'],
              additionalProperties: true,
            },
          },
          required: ['conversationId', 'toDeviceId', 'signal'],
          additionalProperties: false,
        },
        response: {
          [ACCEPTED]: { description: 'Taken; delivered if the target has an open stream. No body.', type: 'null' },
          ...errorResponses(413, 429),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const sender = await requireCallingDevice(db, principal);
      const signal = parseRelayCallSignal(request.body.signal);
      if (signal === null) throw new RelayError(RelayErrorCode.VALIDATION_FAILED, 'The call signal is malformed.');
      const { conversationId } = request.body;
      const target = await requireCallTarget(db, conversationId, sender, request.body.toDeviceId);
      if (signal.type === 'call:ring') {
        const verdict = calls.countRing(sender.userId, target.userId, signal.callId);
        if (!verdict.ok) {
          throw new RateLimitedError(
            verdict.scope === 'user' ? RelayErrorCode.ACTOR_RATE_LIMITED : RelayErrorCode.TARGET_RATE_LIMITED,
            verdict.scope === 'user'
              ? 'This person has placed too many calls; try again later.'
              : 'Too many calls to this person; try again later.',
            retryAfterSeconds(verdict.resetsAt, now()),
          );
        }
      }
      // A signal of a call no ring admitted between these two devices, or over its call's caps, is dropped: still 202.
      // A `call:end` that passes closes its call in the channel and is delivered all the same.
      if (calls.countSignal({ deviceId: sender.id, userId: sender.userId }, target.id, signal)) {
        calls.deliver(target.id, { conversationId, fromUserId: sender.userId, fromDeviceId: sender.id, signal });
      }
      return reply.code(ACCEPTED).send();
    },
  );
}
