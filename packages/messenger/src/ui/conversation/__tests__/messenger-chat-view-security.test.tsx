// @vitest-environment jsdom
/**
 * The conversation view with a room's security state (К5b): the guardian ribbon and the stall banner
 * sit between the host's header and the thread, outside the scroller, so nothing scrolls them away.
 *
 * And the layout check the step asks for: the same chat, badge and sheet mounted at a phone width
 * (390) and a desk width (1440), as a DOM OUTLINE (structure, roles, data attributes), not pixels. The
 * package's responsive behaviour is all CSS, so the two outlines must be identical; the test proves
 * the harness really did mount both form factors by reading the phone media query in each.
 *
 * Test by failure: the strip moved inside the scroller -> the "outside the scroller" test; a branch on
 * the phone query in the markup -> the "same structure at 390 and 1440" test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSecuritySource, makeGuardian, makeSecurityState } from '../../../test-support/fake-security.js';
import { makeMessage, makeMessenger } from '../../../test-support/fake-messenger.js';
import { cleanupUi, click, ensureMatchMedia, q, renderUi } from '../../../test-support/fake-ui.js';
import { ZoneBadge } from '../../security/zone-badge.js';
import { MessengerChatView } from '../messenger-chat-view.js';

afterEach(cleanupUi);

// The bubble prints the message time with `toLocaleTimeString`, which follows the runner's time zone and
// locale ("12:00 p.m." on one machine, "10:00 AM" on CI). The structure snapshot below must not depend on
// either, so the clock is pinned for this file.
const PINNED_CLOCK = '12:00';
beforeAll(() => {
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue(PINNED_CLOCK);
});
afterAll(() => {
  vi.restoreAllMocks();
});

const ROOM = 'c1';
const PHONE_WIDTH = 390;
const DESK_WIDTH = 1440;
const PHONE_QUERY = '(max-width: 767px)';

const guarded = () =>
  makeSecurityState({ guardians: [makeGuardian()], recovery: 'stalled', masia: 'absent', e2ee: 'on' });

const chat = (conversationId: string | null = ROOM) => (
  <MessengerChatView
    messenger={makeMessenger({ messages: [makeMessage({ id: 'a', text: 'hi' })] })}
    currentPersonId="me"
    isGroup={false}
    conversationId={conversationId ?? undefined}
  />
);

describe('MessengerChatView: the security strip', () => {
  it('shows the guardian ribbon and the stall banner above the thread, outside the scroller', () => {
    renderUi(chat(), { security: createFakeSecuritySource({ [ROOM]: guarded() }) });
    const root = q('.hub-mchat')!;
    const scroller = q('.hub-mchat-msgs')!;
    const ribbon = q('.msec-ribbon')!;
    const banner = q('.msec-banner')!;
    expect(ribbon.parentElement).toBe(root);
    expect(banner.parentElement).toBe(root);
    expect(scroller.contains(ribbon)).toBe(false);
    expect(scroller.contains(banner)).toBe(false);
    // document order: ribbon, banner, then the thread
    const order = [...root.children].map((child) => child.className.split(' ')[0]);
    expect(order.slice(0, 3)).toEqual(['msec-ribbon', 'msec-banner', 'hub-mchat-msgs']);
  });

  it('shows them in an empty chat too (a child must know before the first word)', () => {
    renderUi(
      <MessengerChatView messenger={makeMessenger()} currentPersonId="me" isGroup={false} conversationId={ROOM} />,
      { security: createFakeSecuritySource({ [ROOM]: guarded() }) },
    );
    expect(q('.hub-mchat-empty')).toBeTruthy();
    expect(q('.msec-ribbon')!.textContent).toContain('Mom sees this chat');
  });

  it('draws no strip without a conversation id, without a source, or for an unknown room', () => {
    renderUi(chat(null), { security: createFakeSecuritySource({ [ROOM]: guarded() }) });
    expect(q('.msec-ribbon, .msec-banner')).toBeNull();
    cleanupUi();

    renderUi(chat());
    expect(q('.msec-ribbon, .msec-banner')).toBeNull();
    cleanupUi();

    renderUi(chat('elsewhere'), { security: createFakeSecuritySource({ [ROOM]: guarded() }) });
    expect(q('.msec-ribbon, .msec-banner')).toBeNull();
  });

  it("draws the host's banner right under the strip and outside the scroller, and nothing without one", () => {
    renderUi(
      <MessengerChatView
        messenger={makeMessenger({ messages: [makeMessage({ id: 'a', text: 'hi' })] })}
        currentPersonId="me"
        isGroup={false}
        conversationId={ROOM}
        banner={<div className="host-banner">setting up</div>}
      />,
      { security: createFakeSecuritySource({ [ROOM]: guarded() }) },
    );
    const root = q('.hub-mchat')!;
    const banner = q('.host-banner')!;
    expect(banner.parentElement).toBe(root);
    expect(q('.hub-mchat-msgs')!.contains(banner)).toBe(false);
    const order = [...root.children].map((child) => child.className.split(' ')[0]);
    expect(order.slice(0, 4)).toEqual(['msec-ribbon', 'msec-banner', 'host-banner', 'hub-mchat-msgs']);
    cleanupUi();

    renderUi(chat());
    expect(q('.host-banner')).toBeNull();
  });

  it('a calm room with nobody supervising has no strip at all', () => {
    renderUi(chat(), { security: createFakeSecuritySource({ [ROOM]: makeSecurityState() }) });
    expect(q('.msec-ribbon, .msec-banner')).toBeNull();
    expect(q('.hub-mchat')!.firstElementChild!.classList.contains('hub-mchat-msgs')).toBe(true);
  });
});

// ── The layout check: one structure at 390 and at 1440 ───────────────────────

const KEPT_ATTRS = ['role', 'aria-haspopup', 'aria-expanded', 'data-zone', 'data-guardians', 'data-recovery', 'data-cm'];

/** A compact outline of an element tree: tag, classes, the attributes that carry meaning, and leaf text. */
function outline(el: Element, depth = 0): string[] {
  const attrs = KEPT_ATTRS.filter((name) => el.hasAttribute(name)).map((name) => `[${name}=${el.getAttribute(name)}]`);
  const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim()).filter(Boolean);
  const classes = el.classList.length ? `.${[...el.classList].filter((c) => c.startsWith('msec-') || c.startsWith('hub-mchat') || c.startsWith('is-')).join('.')}` : '';
  const icon = el.tagName.toLowerCase() === 'svg' ? `<${el.getAttribute('data-icon')}>` : '';
  const line = `${'  '.repeat(depth)}${el.tagName.toLowerCase()}${classes}${attrs.join('')}${icon}${own.length ? ` "${own.join(' ')}"` : ''}`;
  return [line, ...[...el.children].flatMap((child) => outline(child, depth + 1))];
}

function mountAt(width: number): { structure: string; phone: boolean } {
  window.innerWidth = width;
  const phone = width <= 767;
  ensureMatchMedia(phone);
  const tree = renderUi(
    <div className="host-frame">
      <header className="host-header">
        <ZoneBadge conversationId={ROOM} onOpenDevices={() => undefined} />
      </header>
      {chat()}
    </div>,
    { security: createFakeSecuritySource({ [ROOM]: guarded() }) },
  );
  click(q('.msec-badge'));
  const structure = outline(tree.container).join('\n');
  const reported = window.matchMedia(PHONE_QUERY).matches;
  tree.unmount();
  return { structure, phone: reported };
}

describe('the security UI at 390 and at 1440', () => {
  it('mounts both form factors (the phone query answers differently)', () => {
    expect(mountAt(PHONE_WIDTH).phone).toBe(true);
    expect(mountAt(DESK_WIDTH).phone).toBe(false);
  });

  it('has the same structure at 390 and 1440: responsive behaviour is CSS, not markup', () => {
    expect(mountAt(PHONE_WIDTH).structure).toBe(mountAt(DESK_WIDTH).structure);
  });

  it('the structure: header badge, its open sheet, ribbon, banner, then the thread', () => {
    expect(mountAt(PHONE_WIDTH).structure).toMatchInlineSnapshot(`
      "div
        style "@media (max-width: 35.99375em) {.mantine-visible-from-xs {display: none !important;}}@media (min-width: 36em) {.mantine-hidden-from-xs {display: none !important;}}@media (max-width: 47.99375em) {.mantine-visible-from-sm {display: none !important;}}@media (min-width: 48em) {.mantine-hidden-from-sm {display: none !important;}}@media (max-width: 61.99375em) {.mantine-visible-from-md {display: none !important;}}@media (min-width: 62em) {.mantine-hidden-from-md {display: none !important;}}@media (max-width: 74.99375em) {.mantine-visible-from-lg {display: none !important;}}@media (min-width: 75em) {.mantine-hidden-from-lg {display: none !important;}}@media (max-width: 87.99375em) {.mantine-visible-from-xl {display: none !important;}}@media (min-width: 88em) {.mantine-hidden-from-xl {display: none !important;}}"
        div.
          header.
            button.msec-badge.is-encrypted[aria-haspopup=dialog][aria-expanded=true][data-zone=encrypted]
              span.msec-badge__icon
                svg<lock>
              span.msec-badge__text "Text is encrypted · media we can read"
            div[role=menu][data-cm=security]
              div
                h4 "Security of this room"
                div.msec-sheet[data-zone=encrypted]
                  p.msec-sheet__explain "Text messages here are end-to-end encrypted: only the devices of the people in this room can read them. Masia is not a member."
                  p.msec-sheet__note "Photos and files are not end-to-end encrypted yet: the server can read them."
                  p.msec-sheet__note "The server always sees who talks to whom and when."
                  section.msec-sheet__section.msec-sheet__guardians
                    h5.msec-sheet__heading "Guardians in this room"
                    ul.msec-sheet__list
                      li "Mom sees this chat"
                    p.msec-sheet__note "This cannot be hidden: everyone in the room sees it."
                  section.msec-sheet__section.msec-sheet__code
                    h5.msec-sheet__heading "Security code"
                    p.msec-code
                      span.msec-code__group "A1B2"
                      span.msec-code__group "C3D4"
                      span.msec-code__group "E5F6"
                      span.msec-code__group "0718"
                      span.msec-code__group "293A"
                      span.msec-code__group "4B5C"
                      span.msec-code__group "6D7E"
                      span.msec-code__group "8F90"
                    p.msec-sheet__note.msec-sheet__epoch "Key version 7"
                    p.msec-sheet__note.msec-sheet__hint "Compare this code with the other person, in person or on a call. If it differs, do not trust this room."
              div
                button[role=menuitem]
                  svg<devices>
                  span "Devices in this room"
              button
          div.hub-mchat
            div.msec-ribbon[role=note][data-guardians=1]
              p.msec-ribbon__line
                span.msec-ribbon__icon
                  svg<guardian>
                span.msec-ribbon__text "Mom sees this chat"
            div.msec-banner[role=status][data-recovery=stalled]
              span.msec-banner__icon
                svg<warning>
              span.msec-banner__text "This room is waiting for a key refresh — messages will arrive once it completes."
            div.hub-mchat-msgs
              div.hub-mchat-inner
                div.
                  div.
                    div. "hi"
                    div.
                      span "12:00"
                  button.[aria-haspopup=true][aria-expanded=false]
                    span.
                      svg<more>
            div.
              textarea.
              button.
                svg<send>"
    `);
  });
});
