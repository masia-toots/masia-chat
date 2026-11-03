// @vitest-environment jsdom
/**
 * EpochSystemRow (К5b): the permanent system line of a thread for every kind of epoch change. The chat
 * view has no system-row slot yet, so this is the row on its own; the integration point is documented
 * in the component.
 *
 * Test by failure: a kind added to `EpochEvent` without a row (the switch is exhaustive, tsc fails);
 * the key-change line drawn as calm prose -> the caution test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EpochEvent } from '../../../protocol/security-state.js';
import { cleanupUi, q, renderUi } from '../../../test-support/fake-ui.js';
import { EpochSystemRow } from '../epoch-system-row.js';

afterEach(cleanupUi);

const AT = '2026-10-10T10:00:00.000Z';

const CASES: ReadonlyArray<readonly [EpochEvent, string, string]> = [
  [{ kind: 'device-added', id: 'e1', at: AT, personName: 'Alice', deviceLabel: 'iPhone 17' }, 'Alice added a device: iPhone 17', 'devices'],
  [{ kind: 'device-removed', id: 'e2', at: AT, personName: 'Alice', deviceLabel: 'Pixel 9' }, 'Alice removed a device: Pixel 9', 'devices'],
  [{ kind: 'masia-joined', id: 'e3', at: AT }, 'Masia joined the room', 'masia'],
  [{ kind: 'masia-left', id: 'e4', at: AT }, 'Masia left the room', 'masia'],
  [{ kind: 'key-changed', id: 'e5', at: AT, personName: 'Alice' }, 'Alice’s security key changed — compare security codes', 'warning'],
  [{ kind: 'encryption-on', id: 'e6', at: AT }, 'Encryption is on; earlier history was deleted', 'lock'],
];

describe('EpochSystemRow', () => {
  it.each(CASES)('%j', (event, text, iconName) => {
    renderUi(<EpochSystemRow event={event} />);
    expect(q('.msec-epoch__text')!.textContent).toBe(text);
    expect(q('.msec-epoch__icon svg')!.getAttribute('data-icon')).toBe(iconName);
    expect(q('.msec-epoch')!.getAttribute('data-epoch-kind')).toBe(event.kind);
    expect(q('.msec-epoch')!.getAttribute('data-epoch-id')).toBe(event.id);
    expect(q('.msec-epoch')!.getAttribute('role')).toBe('note');
  });

  it('only a changed key is a caution; the rest are quiet lines', () => {
    for (const [event] of CASES) {
      cleanupUi();
      renderUi(<EpochSystemRow event={event} />);
      expect(q('.msec-epoch')!.classList.contains('is-caution')).toBe(event.kind === 'key-changed');
    }
  });

  it('carries the theme on its own root', () => {
    renderUi(<EpochSystemRow event={CASES[0]![0]} />);
    expect(q<HTMLElement>('.msec-epoch')!.style.getPropertyValue('--msg-warn')).not.toBe('');
  });
});
