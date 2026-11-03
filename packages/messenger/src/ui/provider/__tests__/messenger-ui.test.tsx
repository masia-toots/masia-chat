// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_TOKEN_NAMES } from '@masia/contracts';
import { createFakeThemeTokens } from '@masia/contracts/fakes';
import { cleanupUi, createFakeUi, q, renderUi } from '../../../test-support/fake-ui.js';
import { themeStyle, useIcon, useMessengerUi, useT } from '../messenger-ui.js';

afterEach(cleanupUi);

describe('themeStyle', () => {
  it('turns every theme token into one inline custom property, and nothing else', () => {
    const style = themeStyle(createFakeThemeTokens({ '--msg-radius': '3px' })) as Record<string, string>;
    expect(Object.keys(style).sort()).toEqual([...THEME_TOKEN_NAMES].sort());
    expect(style['--msg-radius']).toBe('3px');
  });
});

describe('MessengerUiProvider', () => {
  it('hands the services and the derived theme style to a screen below it', () => {
    let seen: ReturnType<typeof useMessengerUi> | undefined;
    function Probe() {
      seen = useMessengerUi();
      return null;
    }
    const tree = renderUi(<Probe />);
    expect(seen!.slots).toBe(tree.ui.services.slots);
    expect(seen!.themeStyle).toEqual(themeStyle(tree.ui.services.theme));
  });

  it('keeps one value while the services object is the same, so screens do not re-render for nothing', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useMessengerUi());
      return null;
    }
    const tree = renderUi(<Probe />);
    tree.rerender(<Probe />);
    expect(new Set(seen).size).toBe(1);
  });

  it('is loud when a screen is mounted without a provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Probe() {
      useMessengerUi();
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    expect(() => act(() => root.render(<Probe />))).toThrow(/MessengerUiProvider is missing/);
    error.mockRestore();
  });
});

describe('useT and useIcon', () => {
  it('translate through the bundle and draw through the icon set', () => {
    function Probe() {
      const t = useT();
      const icon = useIcon();
      return (
        <p data-probe="">
          {t('chat.copy')}
          {icon('copy', 12, 'klass')}
        </p>
      );
    }
    renderUi(<Probe />);
    expect(q('[data-probe]')!.textContent).toBe('Copy');
    const svg = q('[data-probe] svg')!;
    expect(svg.getAttribute('data-icon')).toBe('copy');
    expect(svg.getAttribute('data-size')).toBe('12');
    expect(svg.getAttribute('class')).toBe('klass');
  });

  it('keep the same function identity while the bundle is the same', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useT(), useIcon());
      return null;
    }
    const tree = renderUi(<Probe />);
    tree.rerender(<Probe />);
    expect(new Set(seen).size).toBe(2);
  });
});

describe('createFakeUi', () => {
  it('collects the failures the screens send to the host toast', () => {
    const ui = createFakeUi();
    ui.services.env.notifyError('boom');
    expect(ui.notices).toEqual(['boom']);
  });
});
