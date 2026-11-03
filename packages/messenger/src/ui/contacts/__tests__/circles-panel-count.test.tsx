// @vitest-environment jsdom
/**
 * К8a item 6 (plan `icom-player-contacts`, 2026-10-07): the home circle showed 3 on its tab but
 * listed 4 under "In the family". The badge counted `circle.members`; the list rendered EVERY
 * accepted contact and marked membership only with a tick (invisible on an untoggleable family
 * member). One partition now feeds both: `splitByCircle(members, contacts)`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { splitByCircle } from '../../../contacts/index.js';
import { circle, contact, HOME_CIRCLE_ID, makeCircles, seat } from '../../../test-support/fake-circles.js';
import { cleanupUi, click, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { PeoplePanel } from '../people-panel.js';

afterEach(cleanupUi);

// The founder's render pass: three family members seated, plus one pinned friend NOT flagged in.
const members = [seat('alice'), seat('galya'), seat('lesia')];
const contacts = [
  contact('alice', 'alice', true, true),
  contact('galya', 'galya', true, true),
  contact('lesia', 'lesia', true, true),
  contact('lesia2', 'lesia2', true, false),
];

describe('splitByCircle: the one partition', () => {
  it('inside IS members (order and length); outside is every unseated contact', () => {
    const { inside, outside } = splitByCircle(members, contacts);
    expect(inside.map((m) => m.userId)).toEqual(['alice', 'galya', 'lesia']);
    expect(outside.map((c) => c.userId)).toEqual(['lesia2']);
  });

  it('a flagged friend is inside (the host seated them), never duplicated outside', () => {
    const { inside, outside } = splitByCircle([...members, seat('lesia2', true)], contacts);
    expect(inside).toHaveLength(4);
    expect(outside).toHaveLength(0);
  });
});

describe('PeoplePanel: the chip count and the list agree', () => {
  it('home chip 3 -> three rows under "In the family"; the fourth contact under "Other contacts"', () => {
    const family = circle(HOME_CIRCLE_ID, 'Smith', members, true);
    const { data } = makeCircles({ circles: [family], contacts });
    renderUi(<PeoplePanel data={data} onOpenContact={() => undefined} autoFocusSearch={false} />);

    // circles are filter chips: put the home chip in view (the default is "All")
    click(q(`[data-circle-id=${HOME_CIRCLE_ID}]`));
    const badge = Number(q(`[data-circle-id=${HOME_CIRCLE_ID}] .circlesel__tab-n`)!.textContent);
    const inside = qa('[data-sec=members] [data-user-id]');
    const outside = qa('[data-sec=others] [data-user-id]');
    expect(badge).toBe(3);
    expect(inside).toHaveLength(badge);
    expect(outside).toHaveLength(1);
    expect(outside[0]!.dataset.userId).toBe('lesia2');
    // the friend outside can be ADDED; family members inside are owned by their family record: no toggle
    expect(outside[0]!.querySelector('.circlesel__person-tick')?.textContent).toBe('+');
    expect(inside[0]!.querySelector('.circlesel__person-tick')).toBeNull();
  });
});
