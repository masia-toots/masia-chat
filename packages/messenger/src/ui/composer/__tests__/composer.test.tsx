// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupUi, click, pressKey, q, renderUi, typeInto } from '../../../test-support/fake-ui.js';
import { Composer } from '../composer.js';

afterEach(cleanupUi);

const box = (): HTMLTextAreaElement => q<HTMLTextAreaElement>('.msg-composer__input')!;
const send = (): HTMLButtonElement => q<HTMLButtonElement>('.msg-composer__send')!;

describe('Composer', () => {
  it('shows the placeholder, names the send button, and starts with send off', () => {
    renderUi(<Composer onSend={() => undefined} />);
    expect(box().placeholder).toBe('Write a message');
    expect(send().getAttribute('aria-label')).toBe('Send');
    expect(send().querySelector('svg')!.getAttribute('data-icon')).toBe('send');
    expect(send().disabled).toBe(true);
  });

  it('sends the trimmed text on the button and clears the box', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} />);
    typeInto(box(), '  hello  ');
    expect(send().disabled).toBe(false);
    click(send());
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box().value).toBe('');
  });

  it('sends on Enter, keeps the line break on Shift+Enter, and ignores an IME confirmation', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} />);
    typeInto(box(), 'one');
    pressKey(box(), 'Enter', { shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    pressKey(box(), 'Enter', { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    pressKey(box(), 'Enter');
    expect(onSend).toHaveBeenCalledWith('one');
  });

  it('sends nothing for a blank draft', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} />);
    typeInto(box(), '   ');
    pressKey(box(), 'Enter');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('is locked while disabled and does not send even on Enter', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} disabled initialDraft="draft" />);
    expect(box().disabled).toBe(true);
    pressKey(box(), 'Enter');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('seeds the box with the initial draft once', () => {
    renderUi(<Composer onSend={() => undefined} initialDraft="to edit" />);
    expect(box().value).toBe('to edit');
  });

  it('signals typing on the edges only: start once, stop on empty, stop on send', () => {
    const onTyping = vi.fn();
    renderUi(<Composer onSend={() => undefined} onTyping={onTyping} />);
    typeInto(box(), 'a');
    typeInto(box(), 'ab');
    expect(onTyping.mock.calls).toEqual([[true]]);
    typeInto(box(), '');
    expect(onTyping.mock.calls).toEqual([[true], [false]]);
    typeInto(box(), 'x');
    pressKey(box(), 'Enter');
    expect(onTyping.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
