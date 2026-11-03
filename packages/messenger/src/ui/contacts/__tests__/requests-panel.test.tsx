// @vitest-environment jsdom
/**
 * The "Requests" tab (ADR-115 К3): incoming requests are answered here, outgoing ones can be
 * cancelled, a request waiting for a parent shows that state, and the parent queue is its own list.
 * The counts the tab and the door read are the two sums beside it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  incomingRequest,
  makeCircles,
  outgoingRequest,
  parentRequest,
} from '../../../test-support/fake-circles.js';
import { cleanupUi, click, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { incomingRequestCount, openRequestCount, RequestsPanel } from '../requests-panel.js';

afterEach(cleanupUi);

const button = (within: ParentNode, text: string) =>
  qa<HTMLButtonElement>('button', within).find((b) => b.textContent === text)!;

describe('Requests: the sums', () => {
  it('the tab counts every open request, the door only those waiting for MY answer', () => {
    const { data } = makeCircles({
      incoming: [incomingRequest('r1', 'anna'), incomingRequest('r2', 'boris')],
      outgoing: [outgoingRequest('r3', 'carl')],
      awaitingParent: [parentRequest('r4', 'dina', 'eve')],
    });
    expect(openRequestCount(data.requests)).toBe(4);
    expect(incomingRequestCount(data.requests)).toBe(2);
  });
});

describe('Requests: the panel', () => {
  it('an empty tab says so instead of vanishing', () => {
    renderUi(<RequestsPanel data={makeCircles().data} />);
    expect(q('[data-panel=requests] .circlesel__h')?.textContent).toBe('Requests0');
    expect(q('.circlesel__empty')?.textContent).toBe('No requests.');
  });

  it('answers an incoming request: accept and decline report the request id and the verb', () => {
    const { data, fns } = makeCircles({ incoming: [incomingRequest('r1', 'anna')] });
    renderUi(<RequestsPanel data={data} />);
    const row = q('[data-request-id=r1]')!;
    expect(row.dataset.direction).toBe('incoming');
    expect(q('.circlesel__req-who', row)?.textContent).toBe('anna @anna');
    click(button(row, 'Accept'));
    expect(fns.actOnRequest).toHaveBeenLastCalledWith('r1', 'accept');
    click(button(row, 'Decline'));
    expect(fns.actOnRequest).toHaveBeenLastCalledWith('r1', 'decline');
    expect(q('.circlesel__empty')).toBeNull();
  });

  it('an outgoing request can be cancelled; one waiting for a parent says so', () => {
    const { data, fns } = makeCircles({
      outgoing: [outgoingRequest('r2', 'carl'), outgoingRequest('r3', 'dina', true)],
    });
    renderUi(<RequestsPanel data={data} />);
    expect(q('.circlesel__hit-state', q('[data-request-id=r2]')!)).toBeNull();
    expect(q('.circlesel__hit-state', q('[data-request-id=r3]')!)?.textContent).toBe('Waiting for a parent');
    click(button(q('[data-request-id=r2]')!, 'Cancel'));
    expect(fns.actOnRequest).toHaveBeenCalledWith('r2', 'cancel');
  });

  it('the parent queue is its own list with allow and deny', () => {
    const { data, fns } = makeCircles({ awaitingParent: [parentRequest('r4', 'dina', 'eve')] });
    renderUi(<RequestsPanel data={data} />);
    expect(q('h4.circlesel__h')?.textContent).toBe('Waiting for a parent');
    const row = q('[data-request-id=r4]')!;
    expect(q('.circlesel__req-who', row)?.textContent).toBe('dina @dina → eve @eve');
    click(button(row, 'Allow'));
    expect(fns.actOnRequest).toHaveBeenLastCalledWith('r4', 'parent-approve');
    click(button(row, 'Deny'));
    expect(fns.actOnRequest).toHaveBeenLastCalledWith('r4', 'parent-deny');
  });

  it('carries the messenger theme on its own root: it is drawn inside a menu portal', () => {
    renderUi(<RequestsPanel data={makeCircles().data} />);
    expect(q('[data-panel=requests]')?.style.getPropertyValue('--msg-accent-rgb')).toBe('47, 111, 237');
  });
});
