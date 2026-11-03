// @vitest-environment jsdom
/**
 * The "Groups" tab (plan `circles-bank` К4, К5b): the list comes from the groups owner (a group with
 * no chat is still listed), a group's own actions open INLINE, the roster picker offers every
 * accepted contact grouped by circle for reading, and only an admin can change a roster.
 *
 * What turns each test red (mutations of `groups-panel.tsx` the tests are written to catch):
 *   - the picker filtering the pool by circle -> "the pool is every accepted contact";
 *   - `readOnly` dropped for a plain member -> "a plain member sees the roster and cannot change it";
 *   - the admin-only verbs shown to a member -> "rename and delete are an admin's; leaving is anyone's".
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  circle,
  contact,
  group,
  HOME_CIRCLE_ID,
  makeCircles,
  makeGroups,
  seat,
} from '../../../test-support/fake-circles.js';
import { cleanupUi, click, q, qa, renderUi, typeInto } from '../../../test-support/fake-ui.js';
import { GroupsPanel } from '../groups-panel.js';

afterEach(cleanupUi);

const circles = () =>
  makeCircles({
    contacts: [
      contact('mama', 'Mum', true, true),
      contact('olia', 'Olia', true, false),
      contact('maks', 'Max', false, false),
      contact('loner', 'Loner', false, false),
    ],
    circles: [
      circle(HOME_CIRCLE_ID, 'Smith', [seat('mama')], true),
      circle('c-friends', 'Friends', [seat('olia'), seat('maks')]),
      circle('c-empty', 'Empty', []),
    ],
  }).data;

const mount = (
  data: ReturnType<typeof makeGroups>['data'],
  onOpenGroup: (id: string) => void = () => undefined,
) => renderUi(<GroupsPanel data={data} circles={circles()} onOpenGroup={onOpenGroup} />);

const row = (id: string) => q(`.groupman__row[data-group-id=${id}]`)!;
const button = (within: ParentNode, text: string) =>
  qa<HTMLButtonElement>('button', within).find((b) => b.textContent === text)!;

describe('Groups: the list', () => {
  it('lists every group, including one with no chat yet, with its member count', () => {
    const { data } = makeGroups([
      group('g1', 'Trip', [{ userId: 'mama' }, { userId: 'olia' }], 'ADMIN', 'conv-1'),
      group('g2', 'Quiet', [{ userId: 'maks' }], 'MEMBER'),
    ]);
    mount(data);
    expect(q('.groupman__h')?.textContent).toBe('Groups2');
    expect(row('g1').dataset.hasChat).toBe('true');
    expect(row('g2').dataset.hasChat).toBe('false');
    expect(q('.groupman__row-n', row('g1'))?.textContent).toBe('2');
    expect(q('.groupman__row-name', row('g2'))?.textContent).toBe('Quiet');
  });

  it('an empty list says so', () => {
    mount(makeGroups().data);
    expect(q('.groupman__empty')?.textContent).toBe('No groups yet — build the first one from contacts in any circle.');
  });

  it('the name opens the group chat; the chip is drawn as a group', () => {
    const opened: string[] = [];
    mount(makeGroups([group('g1', 'Trip', [{ userId: 'mama' }])]).data, (id) => opened.push(id));
    expect(q('[data-group-id=g1] [data-chip]')?.dataset.chip).toBe('GROUP');
    click(q('.groupman__row-open', row('g1')));
    expect(opened).toEqual(['g1']);
  });
});

describe('Groups: create', () => {
  it('"+ new group" opens the form; create sends the trimmed name and the ticked people, then opens the roster', async () => {
    const owner = makeGroups();
    owner.fns.createGroup.mockResolvedValueOnce(group('g9', 'Picnic', [{ userId: 'olia' }], 'ADMIN'));
    mount(owner.data);

    expect(q('[data-sec=create]')).toBeNull();
    click(q('.groupman__add'));
    const form = q('[data-sec=create]')!;
    expect(button(form, 'Create').disabled).toBe(true); // no name yet

    typeInto(q<HTMLInputElement>('[data-testid=group-name]'), '  Picnic ');
    click(q('[data-sec=create] [data-user-id=olia]'));
    click(q('[data-sec=create] [data-user-id=maks]'));
    click(q('[data-sec=create] [data-user-id=maks]')); // ticked, then unticked
    await act(async () => button(form, 'Create').click());

    expect(owner.fns.createGroup).toHaveBeenCalledWith('Picnic', ['olia']);
  });

  it('the pool is every accepted contact: circle by circle, plus the ones in none', () => {
    mount(makeGroups().data);
    click(q('.groupman__add'));
    const sections = qa('[data-sec=create] .groupman__pool-sec');
    // the home circle is worded by the host's word, empty circles are skipped, the rest is a bucket
    expect(sections.map((s) => s.dataset.circleId)).toEqual([HOME_CIRCLE_ID, 'c-friends', '_rest']);
    expect(sections.map((s) => q('.groupman__pool-h', s)?.textContent)).toEqual(['Family', 'Friends', 'Other contacts']);
    expect(qa('[data-sec=create] .groupman__person').map((p) => p.dataset.userId)).toEqual([
      'mama',
      'olia',
      'maks',
      'loner',
    ]);
  });

  it('with no contacts at all, the picker says where to look', () => {
    renderUi(<GroupsPanel data={makeGroups().data} circles={makeCircles().data} onOpenGroup={() => undefined} />);
    click(q('.groupman__add'));
    expect(q('[data-sec=create] .groupman__empty')?.textContent).toBe(
      'No contacts yet — find someone by @tag under Search.',
    );
  });
});

describe('Groups: the roster', () => {
  it('"Members" opens the roster of that group: ticked people are in, a tick writes through the owner', () => {
    const owner = makeGroups([group('g1', 'Trip', [{ userId: 'olia', role: 'ADMIN' }], 'ADMIN')]);
    mount(owner.data);
    expect(q('[data-sec=members]')).toBeNull();

    click(q('.groupman__row-members', row('g1')));
    expect(q('[data-sec=members] .groupman__h-sub')?.textContent).toBe('Trip');
    expect(q('[data-sec=members] [data-user-id=olia]')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-sec=members] [data-user-id=maks]')?.getAttribute('aria-pressed')).toBe('false');

    click(q('[data-sec=members] [data-user-id=maks]'));
    expect(owner.fns.setMembership).toHaveBeenCalledWith('g1', 'maks', true);
    click(q('[data-sec=members] [data-user-id=olia]'));
    expect(owner.fns.setMembership).toHaveBeenCalledWith('g1', 'olia', false);

    click(q('.groupman__row-members', row('g1'))); // toggles closed
    expect(q('[data-sec=members]')).toBeNull();
  });

  it('a plain member sees the roster and cannot change it', () => {
    const owner = makeGroups([group('g1', 'Trip', [{ userId: 'olia' }], 'MEMBER')]);
    mount(owner.data);
    click(q('.groupman__row-members', row('g1')));
    expect(q('[data-sec=members] .groupman__empty')?.textContent).toBe('Only a group admin can change the roster.');
    const person = q<HTMLButtonElement>('[data-sec=members] [data-user-id=maks]')!;
    expect(person.disabled).toBe(true);
    click(person);
    expect(owner.fns.setMembership).not.toHaveBeenCalled();
  });
});

describe('Groups: the inline actions', () => {
  it('rename and delete are an admin\'s; leaving is anyone\'s', async () => {
    const owner = makeGroups([
      group('g1', 'Trip', [{ userId: 'mama' }], 'ADMIN'),
      group('g2', 'Club', [{ userId: 'mama' }], 'MEMBER'),
    ]);
    mount(owner.data);

    click(q('.groupman__row-more', row('g1')));
    const admin = q('[data-sec=edit-group]')!;
    expect(admin.dataset.groupId).toBe('g1');
    expect(q<HTMLInputElement>('input', admin)?.value).toBe('Trip');
    typeInto(q<HTMLInputElement>('input', admin), ' Trip 2 ');
    await act(async () => button(admin, 'Save').click());
    expect(owner.fns.renameGroup).toHaveBeenCalledWith('g1', 'Trip 2');
    expect(q('[data-sec=edit-group]')).toBeNull(); // saved: the editor closes

    click(q('.groupman__row-more', row('g1')));
    await act(async () => button(q('[data-sec=edit-group]')!, 'Delete group').click());
    expect(owner.fns.deleteGroup).toHaveBeenCalledWith('g1');

    click(q('.groupman__row-more', row('g2')));
    const member = q('[data-sec=edit-group]')!;
    expect(qa('button', member).map((b) => b.textContent)).toEqual(['Leave group', 'Cancel']);
    await act(async () => button(member, 'Leave group').click());
    expect(owner.fns.leaveGroup).toHaveBeenCalledWith('g2');
    expect(owner.fns.deleteGroup).toHaveBeenCalledTimes(1);
  });

  it('the dots toggle the editor; cancel closes it', () => {
    mount(makeGroups([group('g1', 'Trip', [{ userId: 'mama' }], 'ADMIN')]).data);
    const more = q('.groupman__row-more', row('g1'))!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    click(button(q('[data-sec=edit-group]')!, 'Cancel'));
    expect(q('[data-sec=edit-group]')).toBeNull();
  });

  it('carries the messenger theme on its own root: it is drawn inside a menu portal', () => {
    mount(makeGroups().data);
    expect(q('[data-panel=groups]')?.style.getPropertyValue('--msg-accent-rgb')).toBe('47, 111, 237');
  });
});
