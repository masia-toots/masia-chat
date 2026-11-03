import { describe, expect, it } from 'vitest';
import { findListedDevice, isNextDeviceListVersion } from '../device-list.js';
import {
  EpochConflictError,
  FRAMEWORK_ERROR_CODE_BY_STATUS,
  frameworkErrorCode,
  RateLimitedError,
  RELAY_ERROR_STATUS,
  RelayError,
  retryAfterSeconds,
  RoomBusyError,
} from '../errors.js';
import {
  Actor,
  RelayErrorCode,
  administersUser,
  base64Length,
  DeviceRole,
  guardsUser,
  NO_ADMIN_SCOPE,
} from '../index.js';

describe('RelayError', () => {
  it('has a status for every code, so no refusal can fall through to a default', () => {
    for (const code of Object.values(RelayErrorCode)) {
      expect(RELAY_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
  });

  it('reads its status from the one table and merges details into the body', () => {
    const error = new RelayError(RelayErrorCode.DEVICE_LIST_VERSION_CONFLICT, 'stale', {
      currentVersion: 4,
    });
    expect(error.statusCode).toBe(409);
    expect(error.toBody()).toEqual({
      error: 'DEVICE_LIST_VERSION_CONFLICT',
      message: 'stale',
      currentVersion: 4,
    });
  });

  it('lets a detail never overwrite the error code', () => {
    const error = new RelayError(RelayErrorCode.NOT_A_MEMBER, 'no', { error: 'SPOOFED' });
    expect(error.toBody().error).toBe('NOT_A_MEMBER');
  });
});

describe('EpochConflictError', () => {
  it('is a 409 that tells the client which epoch to rebase onto', () => {
    const error = new EpochConflictError(7);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.statusCode).toBe(409);
    expect(error.currentEpoch).toBe(7);
    expect(error.toBody()).toMatchObject({ error: 'EPOCH_CONFLICT', currentEpoch: 7 });
  });
});

describe('retry-after refusals', () => {
  it('rounds the wait up to whole seconds and never answers 0', () => {
    expect(retryAfterSeconds(10_001, 0)).toBe(11);
    expect(retryAfterSeconds(10_000, 0)).toBe(10);
    expect(retryAfterSeconds(5, 5)).toBe(1);
    expect(retryAfterSeconds(0, 5_000)).toBe(1);
  });

  it('a RateLimitedError is a 429 that carries its wait in the body', () => {
    const error = new RateLimitedError(RelayErrorCode.CLAIM_RATE_LIMITED, 'slow down', 7);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.statusCode).toBe(429);
    expect(error.toBody()).toMatchObject({ error: 'CLAIM_RATE_LIMITED', retryAfterSeconds: 7 });
  });

  it('a RoomBusyError is a 503 the client may resend unchanged', () => {
    const error = new RoomBusyError(2);
    expect(error.statusCode).toBe(503);
    expect(error.toBody()).toMatchObject({ error: 'ROOM_BUSY', retryAfterSeconds: 2 });
  });
});

describe('frameworkErrorCode', () => {
  it('names each framework refusal with a code whose status in the one table is that status', () => {
    for (const [status, code] of Object.entries(FRAMEWORK_ERROR_CODE_BY_STATUS)) {
      expect(RELAY_ERROR_STATUS[code], code).toBe(Number(status));
    }
  });

  it('falls back to VALIDATION_FAILED for a 4xx it has no name for', () => {
    expect(frameworkErrorCode(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(frameworkErrorCode(418)).toBe('VALIDATION_FAILED');
  });
});

describe('isNextDeviceListVersion', () => {
  it('wants version 1 as the first list', () => {
    expect(isNextDeviceListVersion(null, 1)).toBe(true);
    expect(isNextDeviceListVersion(null, 2)).toBe(false);
    expect(isNextDeviceListVersion(null, 0)).toBe(false);
  });

  it('wants exactly previous + 1: no repeat, no gap, no going back', () => {
    expect(isNextDeviceListVersion(3, 4)).toBe(true);
    expect(isNextDeviceListVersion(3, 3)).toBe(false);
    expect(isNextDeviceListVersion(3, 5)).toBe(false);
    expect(isNextDeviceListVersion(3, 2)).toBe(false);
  });
});

describe('findListedDevice', () => {
  const devices = [
    { id: 'phone', role: DeviceRole.USER, signatureKey: 'AAAA' },
    { id: 'guardian', role: DeviceRole.GUARDIAN, signatureKey: 'BBBB' },
  ];

  it('finds a device by id', () => {
    expect(findListedDevice(devices, 'guardian')?.role).toBe(DeviceRole.GUARDIAN);
  });

  it('returns undefined for a device that is not on the list', () => {
    expect(findListedDevice(devices, 'tablet')).toBeUndefined();
  });
});

describe('administersUser', () => {
  it('needs the FAMILY_ADMIN marker AND the user in adminOf: neither alone is enough', () => {
    expect(administersUser({ actor: Actor.FAMILY_ADMIN, adminOf: ['kid-b'] }, 'kid-b')).toBe(true);
    // The marker without the user: an admin of family A has no say over family B.
    expect(administersUser({ actor: Actor.FAMILY_ADMIN, adminOf: ['kid-a'] }, 'kid-b')).toBe(false);
    expect(administersUser({ actor: Actor.FAMILY_ADMIN, adminOf: [] }, 'kid-b')).toBe(false);
    // The user without the marker: a list on its own grants nothing.
    expect(administersUser({ actor: null, adminOf: ['kid-b'] }, 'kid-b')).toBe(false);
  });

  it('matches whole user ids only', () => {
    expect(administersUser({ actor: Actor.FAMILY_ADMIN, adminOf: ['kid-bb'] }, 'kid-b')).toBe(
      false,
    );
    expect(administersUser(NO_ADMIN_SCOPE, 'kid-b')).toBe(false);
  });
});

describe('guardsUser', () => {
  it('needs the FAMILY_ADMIN marker AND the minor in guardianOf', () => {
    expect(guardsUser({ actor: Actor.FAMILY_ADMIN, guardianOf: ['kid'] }, 'kid')).toBe(true);
    expect(guardsUser({ actor: null, guardianOf: ['kid'] }, 'kid')).toBe(false);
    expect(guardsUser({ actor: Actor.FAMILY_ADMIN, guardianOf: [] }, 'kid')).toBe(false);
  });

  it('is not implied by adminOf: administering an adult never makes anyone their guardian', () => {
    const scope = { actor: Actor.FAMILY_ADMIN, adminOf: ['partner', 'kid'], guardianOf: ['kid'] };
    expect(administersUser(scope, 'partner')).toBe(true);
    expect(guardsUser(scope, 'partner')).toBe(false);
    expect(guardsUser(NO_ADMIN_SCOPE, 'kid')).toBe(false);
  });
});

describe('base64Length', () => {
  it.each([
    [0, 0],
    [1, 4],
    [3, 4],
    [4, 8],
    [32, 44],
  ])('%i bytes need %i base64 characters', (bytes, expected) => {
    expect(base64Length(bytes)).toBe(expected);
    expect(Buffer.alloc(bytes).toString('base64')).toHaveLength(expected);
  });
});
