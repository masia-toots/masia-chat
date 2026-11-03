import { useCallback, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Modal } from '@mantine/core';
import type {
  HScrollSlotProps,
  LightboxSlotProps,
  MenuSlotProps,
  MessengerUiSlots,
  PersonChipSlotProps,
} from '@masia/messenger/ui';

// The four React pieces the messenger draws with but does not own (`MessengerUiSlots`), written the
// smallest way that works: a menu is a Mantine modal with rows, a gallery is a full-screen modal, the
// scroller is a plain overflow row with two arrows and a person is a coloured initial.

const SCROLL_STEP_PX = 240;
const HUE_SPAN = 360;

export function Menu({
  open,
  onClose,
  label,
  sections,
  tabs,
  defaultTab,
  onTabChange,
  closeLabel,
  wide,
  name,
}: MenuSlotProps): ReactNode {
  const [tab, setTab] = useState<string | undefined>(defaultTab ?? tabs?.[0]?.id);
  const shown = sections.filter((section) => section.tab === undefined || section.tab === tab);
  return (
    <Modal
      opened={open}
      onClose={onClose}
      title={label}
      size={wide ? 'lg' : 'md'}
      closeButtonProps={{ 'aria-label': closeLabel ?? 'Close' }}
      centered
    >
      <div className="demo-menu" data-cm={name}>
        {tabs && tabs.length > 0 && (
          <div className="demo-menu__tabs" role="tablist">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === tab}
                className="demo-menu__tab"
                onClick={() => {
                  setTab(entry.id);
                  onTabChange?.(entry.id);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        {shown.map((section) => (
          <section key={section.id} className="demo-menu__section">
            {section.title && <h3 className="demo-menu__title">{section.title}</h3>}
            {section.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`demo-menu__row${row.destructive ? ' is-destructive' : ''}`}
                aria-current={row.current ? 'true' : undefined}
                onClick={row.onSelect}
              >
                {row.icon}
                <span className="demo-menu__label">
                  {row.label}
                  {row.hint && <span className="demo-menu__hint">{row.hint}</span>}
                </span>
                {row.badge}
              </button>
            ))}
            {section.content}
          </section>
        ))}
      </div>
    </Modal>
  );
}

export function HScroll({
  children,
  className,
  viewportClassName,
  viewportRef,
  role,
  'aria-label': ariaLabel,
  prevLabel,
  nextLabel,
}: HScrollSlotProps): ReactNode {
  const element = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (typeof viewportRef === 'function') viewportRef(node);
      else if (viewportRef) (viewportRef as MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [viewportRef],
  );
  const scrollBy = (direction: 1 | -1) => {
    const node = element.current;
    if (!node) return;
    if (typeof node.scrollBy === 'function') node.scrollBy({ left: direction * SCROLL_STEP_PX, behavior: 'smooth' });
    else node.scrollLeft += direction * SCROLL_STEP_PX;
  };
  return (
    <div className={`demo-hscroll ${className ?? ''}`}>
      <button type="button" className="demo-hscroll__arrow" aria-label={prevLabel ?? 'Previous'} onClick={() => scrollBy(-1)}>
        ‹
      </button>
      <div ref={attach} className={`demo-hscroll__viewport ${viewportClassName ?? ''}`} role={role} aria-label={ariaLabel}>
        {children}
      </div>
      <button type="button" className="demo-hscroll__arrow" aria-label={nextLabel ?? 'Next'} onClick={() => scrollBy(1)}>
        ›
      </button>
    </div>
  );
}

export function Lightbox({ items, index, onIndexChange, onClose }: LightboxSlotProps): ReactNode {
  const item = items[index];
  return (
    <Modal opened onClose={onClose} fullScreen withCloseButton>
      {item && (
        <div className="demo-lightbox">
          <button
            type="button"
            className="demo-lightbox__nav"
            disabled={index <= 0}
            aria-label="Previous picture"
            onClick={() => onIndexChange(index - 1)}
          >
            ‹
          </button>
          <img className="demo-lightbox__image" src={item.src} alt={item.alt} />
          <button
            type="button"
            className="demo-lightbox__nav"
            disabled={index >= items.length - 1}
            aria-label="Next picture"
            onClick={() => onIndexChange(index + 1)}
          >
            ›
          </button>
        </div>
      )}
    </Modal>
  );
}

/** A stable colour for a name: the same person looks the same in both tabs. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % HUE_SPAN;
  return hash;
}

export function PersonChip({ name, avatarUrl, kind, label }: PersonChipSlotProps): ReactNode {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      className={`demo-chip${kind === 'GROUP' ? ' is-group' : ''}`}
      style={{ background: `hsl(${hueOf(name)} 55% 42%)` }}
      title={label ?? name}
      role="img"
      aria-label={label ?? name}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" /> : initial}
    </span>
  );
}

export const demoSlots: MessengerUiSlots = { Menu, HScroll, Lightbox, PersonChip };
