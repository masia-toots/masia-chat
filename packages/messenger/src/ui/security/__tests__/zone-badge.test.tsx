// @vitest-environment jsdom
/**
 * ZoneBadge (К5b): the header badge and the sheet it opens, against the fakes.
 *
 *   - each zone says its own words and wears its own icon; pending shows a spinner, not a lock;
 *   - a room the source knows nothing about draws NOTHING (unknown must not look secure);
 *   - a tap opens the sheet in the host's menu slot; Esc / close hands focus back;
 *   - the sheet lists the zone's explanation, EVERY guardian (never a hidden indicator), the security
 *     code with its compare hint, and a devices link only when the host gave somewhere to go;
 *   - the badge follows the source live and leaves no subscription behind.
 *
 * Test by failure: counting Masia's room as encrypted (zone rule) -> the Masia test; dropping the
 * guardian list from the sheet or hiding it for the guardian's own child -> the guardians test;
 * inventing a devices link without a handler -> the link test; forgetting `unsubscribe` -> the leak test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  makeGuardian,
  makeSecurityState,
  createFakeSecuritySource,
  FAKE_AUTHENTICATOR,
} from '../../../test-support/fake-security.js';
import { cleanupUi, click, pressEscape, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { ZoneBadge } from '../zone-badge.js';

afterEach(cleanupUi);

const ROOM = 'c1';

const mount = (state = makeSecurityState(), props: { onOpenDevices?: () => void } = {}) => {
  const security = createFakeSecuritySource({ [ROOM]: state });
  const tree = renderUi(<ZoneBadge conversationId={ROOM} {...props} />, { security });
  return { ...tree, security };
};

const badge = () => q<HTMLButtonElement>('.msec-badge');
const sheet = () => q('[data-cm="security"]');

describe('ZoneBadge: the four zones', () => {
  it.each([
    [{ e2ee: 'on', masia: 'absent' }, 'encrypted', 'Text is encrypted · media we can read', 'lock'],
    [
      { e2ee: 'on', masia: 'present-server-reads' },
      'masia',
      'Masia zone — the server reads this room',
      'masia',
    ],
    [
      { e2ee: 'off', masia: 'present-server-reads' },
      'masia',
      'Masia zone — the server reads this room',
      'masia',
    ],
    [{ e2ee: 'off', masia: 'absent' }, 'plain', 'Not end-to-end encrypted', 'lock-open'],
  ] as const)('%j → %s', (fields, zone, text, iconName) => {
    mount(makeSecurityState(fields));
    expect(badge()!.getAttribute('data-zone')).toBe(zone);
    expect(q('.msec-badge__text')!.textContent).toBe(text);
    expect(q('.msec-badge__icon svg')!.getAttribute('data-icon')).toBe(iconName);
  });

  it('pending shows a spinner and the setup words, never the lock', () => {
    mount(makeSecurityState({ e2ee: 'pending' }));
    expect(badge()!.getAttribute('data-zone')).toBe('pending');
    expect(q('.msec-badge__text')!.textContent).toBe('Setting up encryption…');
    expect(q('.msec-badge__icon svg')).toBeNull();
    expect(q('.msec-badge__icon .mantine-Loader-root')).toBeTruthy();
  });

  it('carries the theme on its own root and announces a dialog it can open', () => {
    mount();
    expect(badge()!.style.getPropertyValue('--msg-warn')).not.toBe('');
    expect(badge()!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(badge()!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ZoneBadge: an unknown room', () => {
  it('draws nothing when the source has no state for the room', () => {
    const tree = renderUi(<ZoneBadge conversationId="other" />, {
      security: createFakeSecuritySource(),
    });
    expect(tree.container.querySelector('.msec-badge')).toBeNull();
  });

  it('draws nothing when the host mounted no source at all', () => {
    const tree = renderUi(<ZoneBadge conversationId={ROOM} />);
    expect(tree.container.querySelector('.msec-badge')).toBeNull();
    expect(sheet()).toBeNull();
  });
});

describe('ZoneBadge: the sheet', () => {
  it('opens on tap in the host menu slot and closes on Esc', () => {
    mount();
    expect(sheet()).toBeNull();
    click(badge());
    expect(sheet()).toBeTruthy();
    expect(sheet()!.getAttribute('aria-label')).toBe('Security of this room');
    expect(badge()!.getAttribute('aria-expanded')).toBe('true');
    pressEscape();
    expect(sheet()).toBeNull();
    expect(badge()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('a second tap on the badge closes it', () => {
    mount();
    click(badge());
    click(badge());
    expect(sheet()).toBeNull();
  });

  it('an encrypted room explains itself and names what is NOT hidden: media and metadata', () => {
    mount();
    click(badge());
    const text = q('.msec-sheet')!.textContent ?? '';
    expect(text).toContain('Text messages here are end-to-end encrypted');
    expect(text).toContain('Photos and files are not end-to-end encrypted yet');
    expect(text).toContain('The server always sees who talks to whom and when.');
  });

  it("Masia in an encrypted room: her key is the server's, and it is not called end-to-end", () => {
    mount(makeSecurityState({ masia: 'present-server-reads' }));
    click(badge());
    const text = q('.msec-sheet')!.textContent ?? '';
    expect(text).toContain('her key is kept on our server');
    expect(text).toContain('This is not end-to-end encryption.');
    expect(text).not.toContain('Text messages here are end-to-end encrypted');
  });

  it('a plain room and a pending room each say what they are', () => {
    mount(makeSecurityState({ e2ee: 'off' }));
    click(badge());
    expect(q('.msec-sheet__explain')!.textContent).toBe(
      'The server can read this chat. It is not end-to-end encrypted yet.',
    );
    cleanupUi();

    mount(makeSecurityState({ e2ee: 'pending' }));
    click(badge());
    expect(q('.msec-sheet__explain')!.textContent).toContain('still being set up');
  });

  it('lists EVERY guardian, once each, with the line that it cannot be hidden', () => {
    mount(
      makeSecurityState({
        guardians: [
          makeGuardian(),
          makeGuardian({ userId: 'dad', displayName: 'Dad' }),
          makeGuardian({ userId: 'mom', displayName: 'Mom' }), // a second device of the same adult
        ],
      }),
    );
    click(badge());
    expect(qa('.msec-sheet__guardians li').map((li) => li.textContent)).toEqual([
      'Mom sees this chat',
      'Dad sees this chat',
    ]);
    expect(q('.msec-sheet__guardians')!.textContent).toContain('This cannot be hidden');
  });

  it('has no guardian section when there are none', () => {
    mount();
    click(badge());
    expect(q('.msec-sheet__guardians')).toBeNull();
  });

  it('shows the security code in groups, the key version and the compare hint', () => {
    mount();
    click(badge());
    const groups = qa('.msec-code__group').map((g) => g.textContent?.trim());
    expect(groups).toEqual(FAKE_AUTHENTICATOR.split(' '));
    expect(q('.msec-code')!.getAttribute('data-code')).toBe(FAKE_AUTHENTICATOR);
    expect(q('.msec-sheet__epoch')!.textContent).toBe('Key version 7');
    expect(q('.msec-sheet__hint')!.textContent).toBe(
      'Compare this code with the other person, in person or on a call. If it differs, do not trust this room.',
    );
  });

  it('a bigint epoch is written as a number', () => {
    mount(makeSecurityState({ epoch: 12345678901234567890n }));
    click(badge());
    expect(q('.msec-sheet__epoch')!.textContent).toBe('Key version 12345678901234567890');
  });

  it('says the code is not available yet rather than showing an empty box', () => {
    mount(makeSecurityState({ epochAuthenticator: undefined }));
    click(badge());
    expect(q('.msec-code')).toBeNull();
    expect(q('.msec-sheet__code')!.textContent).toContain(
      'The security code is not available yet.',
    );
  });

  it('shows no code for a room that is not encrypted (there is no group to compare)', () => {
    mount(makeSecurityState({ e2ee: 'off', epochAuthenticator: FAKE_AUTHENTICATOR }));
    click(badge());
    expect(q('.msec-sheet__code')).toBeNull();
  });

  it('offers the devices link only when the host gave somewhere to go, and goes there', () => {
    mount();
    click(badge());
    expect(q('[data-cm-row="devices"]')).toBeNull();
    cleanupUi();

    const onOpenDevices = vi.fn();
    mount(makeSecurityState(), { onOpenDevices });
    click(badge());
    const row = q('[data-cm-row="devices"]')!;
    expect(row.textContent).toContain('Devices in this room');
    click(row);
    expect(onOpenDevices).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull(); // choosing a row closes the sheet
  });

  it('draws the sheet body with its own theme (it may be portaled out of the root)', () => {
    mount();
    click(badge());
    expect(q<HTMLElement>('.msec-sheet')!.style.getPropertyValue('--msg-accent')).not.toBe('');
  });
});

describe('ZoneBadge: follows the source', () => {
  it('redraws when the room changes, and an open sheet follows it', () => {
    const { security } = mount(makeSecurityState({ e2ee: 'pending' }));
    expect(badge()!.getAttribute('data-zone')).toBe('pending');
    click(badge());
    act(() => security.set(ROOM, makeSecurityState({ e2ee: 'on', epoch: 8 })));
    expect(badge()!.getAttribute('data-zone')).toBe('encrypted');
    expect(q('.msec-sheet__epoch')!.textContent).toBe('Key version 8');
  });

  it('disappears when the source forgets the room', () => {
    const { security } = mount();
    act(() => security.set(ROOM, undefined));
    expect(badge()).toBeNull();
  });

  it('subscribes once and leaves no subscription behind', () => {
    const { security, unmount } = mount();
    expect(security.subscriberCount(ROOM)).toBe(1);
    unmount();
    expect(security.subscriberCount(ROOM)).toBe(0);
  });
});
