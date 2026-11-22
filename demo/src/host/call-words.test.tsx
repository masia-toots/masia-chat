import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CALL_ICON_NAMES, CALL_SCREEN_TEXT_KEYS } from '@masia/messenger/call/react';
import { CALL_GLYPHS, callIcon } from './call-icons.js';
import { CALL_ENTRY_HINTS, CALL_REFUSALS, CALL_SCREEN_TEXTS, callText, fillText } from './call-texts.js';

// The tables are Records over the package's key types, so a missing key already fails the typecheck.
// These tests hold the same at run time, and check what a type cannot: no empty sentence, every
// placeholder filled, and an SVG drawn for every icon.

const PLACEHOLDER = /\{\{\w+\}\}/;

describe('the call screen\'s words', () => {
  it('has a sentence for every key the screen asks for, and no key the screen does not know', () => {
    expect(Object.keys(CALL_SCREEN_TEXTS).sort()).toEqual([...CALL_SCREEN_TEXT_KEYS].sort());
    for (const key of CALL_SCREEN_TEXT_KEYS) {
      expect(callText(key, { name: 'Ada', count: 2 }).trim(), key).not.toBe('');
    }
  });

  it('fills every placeholder the screen gives a value for', () => {
    for (const key of CALL_SCREEN_TEXT_KEYS) {
      expect(callText(key, { name: 'Ada', count: 1 }), key).not.toMatch(PLACEHOLDER);
      expect(callText(key, { name: 'Ada', count: 3 }), key).not.toMatch(PLACEHOLDER);
    }
    expect(callText('dialog', { name: 'Ada' })).toBe('Call with Ada');
  });

  it('says one device and several devices differently', () => {
    expect(callText('others.theirs', { count: 1 })).toBe('1 other device of theirs');
    expect(callText('others.theirs', { count: 2 })).toBe('2 other devices of theirs');
    expect(callText('others.assistant', { count: 1 })).toBe('1 assistant device');
  });

  it('leaves a placeholder with no value as written, so a missing value shows', () => {
    expect(fillText('Call with {{name}}')).toBe('Call with {{name}}');
    expect(fillText('{{a}} and {{b}}', { a: 1 })).toBe('1 and {{b}}');
  });

  it('words every reason «Call» may be disabled or refused', () => {
    for (const text of [...Object.values(CALL_ENTRY_HINTS), ...Object.values(CALL_REFUSALS)]) {
      expect(text.trim()).not.toBe('');
    }
  });
});

describe('the call screen\'s icons', () => {
  it('draws every icon the screen asks for, and no other', () => {
    expect(Object.keys(CALL_GLYPHS).sort()).toEqual([...CALL_ICON_NAMES].sort());
    for (const name of CALL_ICON_NAMES) {
      const markup = renderToStaticMarkup(<>{callIcon(name, 20)}</>);
      expect(markup, name).toMatch(/^<svg [^>]*width="20"[^>]*height="20"/);
      expect(markup, name).toContain('aria-hidden="true"');
      // A glyph is drawn, not an empty frame.
      expect(markup, name).toMatch(/<(path|rect|circle)\b/);
    }
  });

  it('turns the handset when the screen asks (the red buttons)', () => {
    expect(renderToStaticMarkup(<>{callIcon('phone', 20, 135)}</>)).toContain('rotate(135 12 12)');
    expect(renderToStaticMarkup(<>{callIcon('phone', 20)}</>)).not.toContain('rotate(');
  });
});
