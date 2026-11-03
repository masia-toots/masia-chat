// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createFakeThemeTokens } from '@masia/contracts/fakes';
import { isValidElement, type ReactElement } from 'react';
import { createFakeReactIconSet } from '../../../test-support/fake-ui.js';
import { themeStyle } from '../../provider/messenger-ui.js';
import { convPickerRows, type ConvPickerProps } from '../conv-picker.js';

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

describe('convPickerRows: one builder for the chip and the folded header menu', () => {
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

  it('gives the space suffix only to a conversation attached to a space', () => {
    const rows = convPickerRows(picker(), env);
    expect(isValidElement(rows[1]!.hint)).toBe(true);
    expect(rows[0]!.hint).toBeUndefined();
  });
});
