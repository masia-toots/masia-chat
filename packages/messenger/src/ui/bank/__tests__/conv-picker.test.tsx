// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createFakeThemeTokens } from '@masia/contracts/fakes';
import { isValidElement, type ReactElement } from 'react';
import { createFakeReactIconSet } from '../../../test-support/fake-ui.js';
import { themeStyle } from '../../provider/messenger-ui.js';
import { clipAtWord, convPickerRows, plainConvLabel, type ConvPickerProps } from '../conv-picker.js';

const env = { icons: createFakeReactIconSet(), themeStyle: themeStyle(createFakeThemeTokens()) };

const picker = (onPick = vi.fn()): ConvPickerProps => ({
  title: 'Ada · conversations',
  onPick,
  items: [
    { id: 'c1', label: 'Main', glyph: 'pin', current: true },
    { id: 'c2', label: 'Trip', glyph: 'chat', current: false, spaceName: 'Travel', unread: 3 },
    { id: 'c3', label: 'Quiet', glyph: 'lock', current: false },
  ],
});

describe("convPickerRows: one builder for the header menu's «Чати» tab", () => {
  it('maps every conversation to a row; the current one is marked, a pick reports its id', () => {
    const onPick = vi.fn();
    const rows = convPickerRows(picker(onPick), env);
    expect(rows.map((r) => r.id)).toEqual(['conv:c1', 'conv:c2', 'conv:c3']);
    expect(rows.map((r) => r.current)).toEqual([true, false, false]);
    rows[1]!.onSelect();
    expect(onPick).toHaveBeenCalledWith('c2');
  });

  it('draws each glyph at row size from the icon set', () => {
    const rows = convPickerRows(picker(), env);
    const icons = rows.map((r) => (r.icon as ReactElement<{ 'data-icon': string; 'data-size': string }>).props);
    expect(icons.map((p) => `${p['data-icon']}:${p['data-size']}`)).toEqual(['pin:16', 'chat:16', 'lock:16']);
  });

  it('shows a tick on the current row, the unread count on another, and nothing on a plain one', () => {
    const rows = convPickerRows(picker(), env);
    expect((rows[0]!.badge as ReactElement<{ 'data-icon': string }>).props['data-icon']).toBe('check');
    const unread = rows[1]!.badge as ReactElement<{ className: string; children: number; style: object }>;
    expect(unread.props.className).toBe('chbank-convs__unread');
    expect(unread.props.children).toBe(3);
    expect(rows[2]!.badge).toBeUndefined();
  });

  it('carries the theme on the unread badge itself: it is drawn in a menu portal, outside the bank', () => {
    const rows = convPickerRows(picker(), env);
    const unread = rows[1]!.badge as ReactElement<{ style: Record<string, string> }>;
    expect(unread.props.style['--msg-accent-rgb']).toBe('47, 111, 237');
  });

  it('shows a chat name as plain text — the markdown a fork is named by (the head of its last message) is dropped', () => {
    const rows = convPickerRows(
      {
        ...picker(),
        items: [
          { id: 'a', label: '**Конфлікт у Ормузькій протоці**: що далі', glyph: 'chat', current: false },
          { id: 'b', label: '**Конфлікт у Ормузь', glyph: 'chat', current: false }, // cut by the host mid-bold: no closing mark
          { id: 'c', label: '**', glyph: 'chat', current: false },
        ],
      },
      env,
    );
    expect(rows.map((r) => r.label)).toEqual(['Конфлікт у Ормузькій протоці: що далі', 'Конфлікт у Ормузь', '**']);
  });

  it('gives the space suffix only to a conversation attached to a space', () => {
    const rows = convPickerRows(picker(), env);
    expect(isValidElement(rows[1]!.hint)).toBe(true);
    expect(rows[0]!.hint).toBeUndefined();
  });
});

describe('clipAtWord — a long name is cut at a word and says so', () => {
  const essay = 'Привіт! У мене все добре, дякую, що запитав. А як твої справи? Чим можу допомогти тобі сьогодні, друже?';

  it('keeps whole words up to the cap and ends with «…» (never «допомогт»)', () => {
    const out = clipAtWord(essay, 80);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(81);
    expect(essay.startsWith(out.slice(0, -1))).toBe(true);
    expect(essay.charAt(out.length - 1)).toBe(' '); // the cut sits on a word boundary
  });

  it('leaves a name that fits exactly as it is', () => {
    expect(clipAtWord('мася, як справи?')).toBe('мася, як справи?');
  });

  it('an unbroken token longer than the cap is cut where it stands, still marked', () => {
    expect(clipAtWord('x'.repeat(100), 80)).toBe(`${'x'.repeat(80)}…`);
  });

  it('the rows carry the clipped, plain name', () => {
    const rows = convPickerRows({ ...picker(), items: [{ id: 'a', label: `**${essay}**`, glyph: 'chat', current: false }] }, env);
    expect(rows[0]!.label.endsWith('…')).toBe(true);
    expect(rows[0]!.label).not.toContain('*');
  });
});

describe('plainConvLabel', () => {
  it.each([
    ['**Bold** and __bold__ and ~~gone~~ and `code`', 'Bold and bold and gone and code'],
    ['# Heading\n- first\n> quote', 'Heading first quote'],
    ['[a link](https://example.com/x) here', 'a link here'],
    ['*one* and _two_ words', 'one and two words'],
    ['keep snake_case and 2*3 and a * b', 'keep snake_case and 2*3 and a * b'],
    ['  plain   text  ', 'plain text'],
  ])('%j → %j', (raw, plain) => {
    expect(plainConvLabel(raw)).toBe(plain);
  });
});
