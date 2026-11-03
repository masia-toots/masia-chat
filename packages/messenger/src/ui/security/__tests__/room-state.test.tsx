// @vitest-environment jsdom
/**
 * The room's live E2EE state and this device's own protection (К8, canon section 11).
 *
 * Test by failure: a "sending" line that disables the composer, or that outranks "removed", fails the
 * order test; a browser that says nothing about its weaker key store fails the honesty test; a sheet
 * that claims isolation when the host did not say so fails the "nothing by default" test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  createFakeSecuritySource,
  makeSecurityState,
} from '../../../test-support/fake-security.js';
import { cleanupUi, q, renderUi } from '../../../test-support/fake-ui.js';
import { formatHistoryDate, RoomStateBanner, roomStateLineOf } from '../room-state-banner.js';
import { SecuritySheetBody } from '../security-sheet.js';
import { SecurityStrip } from '../security-strip.js';

afterEach(cleanupUi);

const ROOM = 'room-1';

describe('RoomStateBanner', () => {
  it('says the most serious thing first', () => {
    expect(roomStateLineOf({ sending: true, removed: true, signInRequired: true })).toBe(
      'roomState.signIn',
    );
    expect(roomStateLineOf({ sending: true, removed: true })).toBe('roomState.removed');
    expect(roomStateLineOf({ sending: true, readOnly: true })).toBe('roomState.readOnly');
    expect(roomStateLineOf({ sending: true, historyBefore: '2026-01-01T00:00:00Z' })).toBe(
      'roomState.historyGap',
    );
    expect(roomStateLineOf({ sending: true })).toBe('roomState.sending');
    expect(roomStateLineOf({})).toBeUndefined();
  });

  it('a history gap names the date in the reader language', () => {
    renderUi(
      <RoomStateBanner state={makeSecurityState({ historyBefore: '2026-03-05T12:00:00Z' })} />,
    );
    expect(q('.msec-banner__text')!.textContent).toBe(
      `History before ${formatHistoryDate('2026-03-05T12:00:00Z', 'en')} is on your other devices.`,
    );
    expect(formatHistoryDate('2026-03-05T12:00:00Z', 'en')).toContain('2026');
    expect(formatHistoryDate('not a date', 'en')).toBe('not a date');
  });

  it('"sending" is a quiet status line, with no button and no way to dismiss', () => {
    renderUi(<RoomStateBanner state={makeSecurityState({ sending: true })} />);
    const banner = q('.msec-banner')!;
    expect(banner.getAttribute('data-room-state')).toBe('roomState.sending');
    expect(banner.className).toContain('msec-banner--quiet');
    expect(banner.querySelector('button')).toBeNull();
  });

  it('draws nothing for a healthy room', () => {
    const tree = renderUi(<RoomStateBanner state={makeSecurityState()} />);
    expect(tree.container.querySelector('.msec-banner')).toBeNull();
  });

  it('the strip follows the source: removed appears, then clears', () => {
    const security = createFakeSecuritySource({ [ROOM]: makeSecurityState() });
    renderUi(<SecurityStrip conversationId={ROOM} />, { security });
    expect(q('[data-room-state]')).toBeNull();
    act(() => security.set(ROOM, makeSecurityState({ removed: true })));
    expect(q('[data-room-state]')!.getAttribute('data-room-state')).toBe('roomState.removed');
    act(() => security.set(ROOM, makeSecurityState()));
    expect(q('[data-room-state]')).toBeNull();
  });
});

describe('This device, in the security sheet', () => {
  it('nothing is claimed when the host did not say', () => {
    renderUi(<SecuritySheetBody state={makeSecurityState()} />);
    expect(q('.msec-sheet__device')).toBeNull();
  });

  it('a browser says the weaker key store in the words of the threat', () => {
    renderUi(
      <SecuritySheetBody
        state={makeSecurityState({ thisDevice: { engineIsolated: true, keyStore: 'browser' } })}
      />,
    );
    const section = q('.msec-sheet__device')!;
    expect(section.getAttribute('data-engine-isolated')).toBe('yes');
    expect(section.textContent).toContain('casual browsing only');
    expect(section.textContent).toContain('apart from this page');
  });

  it('an engine sharing the page says so; a phone names its hardware store', () => {
    renderUi(
      <SecuritySheetBody
        state={makeSecurityState({ thisDevice: { engineIsolated: false, keyStore: 'hardware' } })}
      />,
    );
    const section = q('.msec-sheet__device')!;
    expect(section.getAttribute('data-engine-isolated')).toBe('no');
    expect(section.textContent).toContain('inside this page');
    expect(section.textContent).toContain('hardware-backed');
  });
});
