/**
 * The zone rule is a pure function of two fields; this pins every cell of its table, because a wrong
 * cell is a false claim on a security badge.
 */
import { describe, expect, it } from 'vitest';
import type { E2eeStatus, MasiaPresence } from '../../../protocol/security-state.js';
import { distinctGuardians, explanationKeyOf, GUARDIAN_NAMED_MAX, ZONE, zoneOf } from '../zone.js';

const E2EE: readonly E2eeStatus[] = ['off', 'pending', 'on'];
const MASIA: readonly MasiaPresence[] = ['absent', 'present-server-reads'];

describe('zoneOf: the whole table', () => {
  it.each([
    ['off', 'absent', ZONE.PLAIN],
    ['pending', 'absent', ZONE.PENDING],
    ['on', 'absent', ZONE.ENCRYPTED],
    ['off', 'present-server-reads', ZONE.MASIA],
    ['pending', 'present-server-reads', ZONE.MASIA],
    ['on', 'present-server-reads', ZONE.MASIA],
  ] as const)('e2ee %s, Masia %s → %s', (e2ee, masia, zone) => {
    expect(zoneOf({ e2ee, masia })).toBe(zone);
  });

  it('covers every combination the types allow', () => {
    const cells = E2EE.flatMap((e2ee) => MASIA.map((masia) => zoneOf({ e2ee, masia })));
    expect(cells).toHaveLength(6);
  });

  it('never calls a room encrypted while Masia, whose key is the server\'s, is in it', () => {
    for (const e2ee of E2EE) expect(zoneOf({ e2ee, masia: 'present-server-reads' })).not.toBe(ZONE.ENCRYPTED);
  });

  it('never calls a pending room encrypted', () => {
    expect(zoneOf({ e2ee: 'pending', masia: 'absent' })).not.toBe(ZONE.ENCRYPTED);
  });
});

describe('explanationKeyOf', () => {
  it('has a distinct, honest sentence per situation', () => {
    expect(explanationKeyOf({ e2ee: 'on', masia: 'absent' })).toBe('zone.explainEncrypted');
    expect(explanationKeyOf({ e2ee: 'pending', masia: 'absent' })).toBe('zone.explainPending');
    expect(explanationKeyOf({ e2ee: 'off', masia: 'absent' })).toBe('zone.explainPlain');
    expect(explanationKeyOf({ e2ee: 'on', masia: 'present-server-reads' })).toBe('zone.explainMasiaMember');
    expect(explanationKeyOf({ e2ee: 'off', masia: 'present-server-reads' })).toBe('zone.explainMasiaServer');
    expect(explanationKeyOf({ e2ee: 'pending', masia: 'present-server-reads' })).toBe('zone.explainMasiaServer');
  });
});

describe('distinctGuardians', () => {
  it('keeps the first entry per user and the order', () => {
    const list = [
      { userId: 'a', n: 1 },
      { userId: 'b', n: 2 },
      { userId: 'a', n: 3 },
    ];
    expect(distinctGuardians(list)).toEqual([
      { userId: 'a', n: 1 },
      { userId: 'b', n: 2 },
    ]);
  });

  it('names at most two guardians before it counts', () => {
    expect(GUARDIAN_NAMED_MAX).toBe(2);
  });
});
