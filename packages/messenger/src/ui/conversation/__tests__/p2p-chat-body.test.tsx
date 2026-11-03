// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SLOTS, cleanupUi, click, q, renderUi } from '../../../test-support/fake-ui.js';
import { makeMessage, makeMessenger } from '../../../test-support/fake-messenger.js';
import type { ComposerSlotProps } from '../../provider/slots.js';
import { P2PChatBody } from '../p2p-chat-body.js';

afterEach(cleanupUi);

/** A host composer that exposes only its sticker control. */
function StickerComposer({ onStickers }: ComposerSlotProps) {
  return onStickers ? <button type="button" data-open-stickers="" onClick={onStickers} /> : <span data-no-stickers="" />;
}

describe('P2PChatBody', () => {
  it('renders the conversation for the messenger it is given', () => {
    renderUi(<P2PChatBody messenger={makeMessenger({ messages: [makeMessage({ text: 'ping' })] })} currentPersonId="me" isGroup={false} />);
    expect(q('.hub-msg-text')!.textContent).toBe('ping');
  });

  it('has no sticker control without a picker', () => {
    renderUi(<P2PChatBody messenger={makeMessenger()} currentPersonId="me" isGroup={false} />, {
      slots: { ...FAKE_SLOTS, Composer: StickerComposer },
    });
    expect(q('[data-no-stickers]')).toBeTruthy();
  });

  it('opens the host picker from the composer and closes it from the picker', () => {
    const states: boolean[] = [];
    renderUi(
      <P2PChatBody
        messenger={makeMessenger()}
        currentPersonId="me"
        isGroup={false}
        renderStickers={({ opened, close }) => {
          states.push(opened);
          return (
            <div data-picker={String(opened)}>
              <button type="button" data-picker-close="" onClick={close} />
            </div>
          );
        }}
      />,
      { slots: { ...FAKE_SLOTS, Composer: StickerComposer } },
    );
    // Mounted from the start (a picker that animates out must stay mounted), shown only when opened.
    expect(q('[data-picker]')!.getAttribute('data-picker')).toBe('false');
    click(q('[data-open-stickers]'));
    expect(q('[data-picker]')!.getAttribute('data-picker')).toBe('true');
    click(q('[data-picker-close]'));
    expect(q('[data-picker]')!.getAttribute('data-picker')).toBe('false');
    expect(states).toContain(true);
  });
});
