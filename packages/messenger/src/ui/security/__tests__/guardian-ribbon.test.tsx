// @vitest-environment jsdom
/**
 * GuardianRibbon and RecoveryBanner (К5b), plus the strip that carries them into the thread.
 *
 * The guardian ribbon is the child's right to know ("Mom sees this chat") and the other family's right
 * to know: it is shown to every member and cannot be closed. The stall banner is honest about waiting
 * and equally cannot be waved away.
 *
 * Test by failure: a close button / dismiss state on either -> the "no way to hide it" tests; naming
 * 3 guardians one by one -> the collapse test; showing the banner for `none` -> the banner test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createFakeSecuritySource, makeGuardian, makeSecurityState } from '../../../test-support/fake-security.js';
import { cleanupUi, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { GuardianRibbon } from '../guardian-ribbon.js';
import { RecoveryBanner } from '../recovery-banner.js';
import { SecurityStrip } from '../security-strip.js';

afterEach(cleanupUi);

const lines = () => qa('.msec-ribbon__text').map((n) => n.textContent);

describe('GuardianRibbon', () => {
  it('names one guardian: "<name> sees this chat"', () => {
    renderUi(<GuardianRibbon guardians={[makeGuardian()]} />);
    expect(lines()).toEqual(['Mom sees this chat']);
    expect(q('.msec-ribbon__icon svg')!.getAttribute('data-icon')).toBe('guardian');
  });

  it('names two guardians, one line each', () => {
    renderUi(<GuardianRibbon guardians={[makeGuardian(), makeGuardian({ userId: 'dad', displayName: 'Dad' })]} />);
    expect(lines()).toEqual(['Mom sees this chat', 'Dad sees this chat']);
  });

  it('beyond two it counts instead of naming, still one visible line', () => {
    renderUi(
      <GuardianRibbon
        guardians={[
          makeGuardian(),
          makeGuardian({ userId: 'dad', displayName: 'Dad' }),
          makeGuardian({ userId: 'gran', displayName: 'Gran' }),
          makeGuardian({ userId: 'uncle', displayName: 'Uncle' }),
        ]}
      />,
    );
    expect(lines()).toEqual(['4 adults see this chat']);
  });

  it('counts people, not devices: one adult with two devices is one adult', () => {
    renderUi(<GuardianRibbon guardians={[makeGuardian(), makeGuardian(), makeGuardian({ userId: 'dad', displayName: 'Dad' })]} />);
    expect(lines()).toEqual(['Mom sees this chat', 'Dad sees this chat']);
  });

  it('draws nothing when nobody supervises', () => {
    const tree = renderUi(<GuardianRibbon guardians={[]} />);
    expect(tree.container.querySelector('.msec-ribbon')).toBeNull();
  });

  it('has no way to hide it: no button, no close, no dismiss state', () => {
    renderUi(<GuardianRibbon guardians={[makeGuardian()]} />);
    expect(qa('button, [role=button], [data-dismiss]', q('.msec-ribbon')!)).toHaveLength(0);
    expect(q('.msec-ribbon')!.getAttribute('role')).toBe('note');
  });

  it('carries the theme on its own root', () => {
    renderUi(<GuardianRibbon guardians={[makeGuardian()]} />);
    expect(q<HTMLElement>('.msec-ribbon')!.style.getPropertyValue('--msg-warn')).not.toBe('');
  });
});

describe('RecoveryBanner', () => {
  it('says the room is waiting, promises an order and not a time', () => {
    renderUi(<RecoveryBanner recovery="stalled" />);
    const text = q('.msec-banner')!.textContent!;
    expect(text).toBe('This room is waiting for a key refresh — messages will arrive once it completes.');
    expect(text).not.toMatch(/\d|minute|second|soon|shortly/i);
    expect(q('.msec-banner')!.getAttribute('role')).toBe('status');
    expect(q('.msec-banner__icon svg')!.getAttribute('data-icon')).toBe('warning');
  });

  it('is not dismissable: no button, no close', () => {
    renderUi(<RecoveryBanner recovery="stalled" />);
    expect(qa('button, [role=button], [data-dismiss]', q('.msec-banner')!)).toHaveLength(0);
  });

  it.each([undefined, 'none'] as const)('draws nothing for %s', (recovery) => {
    const tree = renderUi(<RecoveryBanner recovery={recovery} />);
    expect(tree.container.querySelector('.msec-banner')).toBeNull();
  });
});

describe('SecurityStrip', () => {
  const ROOM = 'c1';

  it('carries the ribbon and the banner for the room', () => {
    const security = createFakeSecuritySource({
      [ROOM]: makeSecurityState({ guardians: [makeGuardian()], recovery: 'stalled' }),
    });
    renderUi(<SecurityStrip conversationId={ROOM} />, { security });
    expect(q('.msec-ribbon')).toBeTruthy();
    expect(q('.msec-banner')).toBeTruthy();
  });

  it('draws nothing for an unknown room, no id, or no source', () => {
    const security = createFakeSecuritySource();
    const strip = (host: HTMLElement) => host.querySelector('.msec-ribbon, .msec-banner');
    const tree = renderUi(<SecurityStrip conversationId="nope" />, { security });
    expect(strip(tree.container)).toBeNull();
    tree.rerender(<SecurityStrip conversationId={undefined} />);
    expect(strip(tree.container)).toBeNull();
    cleanupUi();
    const bare = renderUi(<SecurityStrip conversationId={ROOM} />);
    expect(strip(bare.container)).toBeNull();
  });

  it('shows a guardian the moment one is added, and the banner the moment the room stalls and recovers', () => {
    const security = createFakeSecuritySource({ [ROOM]: makeSecurityState() });
    renderUi(<SecurityStrip conversationId={ROOM} />, { security });
    expect(q('.msec-ribbon')).toBeNull();
    act(() => security.set(ROOM, makeSecurityState({ guardians: [makeGuardian()], recovery: 'stalled' })));
    expect(lines()).toEqual(['Mom sees this chat']);
    expect(q('.msec-banner')).toBeTruthy();
    act(() => security.set(ROOM, makeSecurityState({ guardians: [makeGuardian()], recovery: 'none' })));
    expect(q('.msec-banner')).toBeNull();
    expect(q('.msec-ribbon')).toBeTruthy(); // recovering never hides the guardian
  });
});
