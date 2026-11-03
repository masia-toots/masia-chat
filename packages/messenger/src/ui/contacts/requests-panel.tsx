/**
 * RequestsPanel: the body of the "Requests" tab of the contacts menu (ADR-115 К3).
 *
 * Founder 2026-09-01: «Після пікнутих контактів — буде селектор кола та контактів … із КРАД
 * інтерфейсом кіл та глобальним пошуком контактів по мася тегу. … Родина це просто дефолтне коло».
 *
 * The circles row, the member lists and the `@tag` search live in ONE body (`PeoplePanel`). What
 * stays here is the request list (incoming, outgoing, waiting for a parent) and the one sum both
 * the tab's count and the door's badge are read from.
 */
import type { ReactNode } from 'react';
import { Button } from '@mantine/core';
import type { ContactCircles, ContactRequest } from '../../contacts/index.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import './circle-selector.css';

/** How many requests are open: the "Requests · N" tab's count. */
export function openRequestCount(requests: ContactCircles['requests']): number {
  return requests.incoming.length + requests.outgoing.length + requests.awaitingParent.length;
}

/** How many requests wait for MY answer: the door's badge and the header menu row's badge. */
export function incomingRequestCount(requests: ContactCircles['requests']): number {
  return requests.incoming.length;
}

const personTag = (u: ContactRequest['fromUser']): string =>
  u.username ? `${u.displayName} @${u.username}` : u.displayName;

/** A TAB body, so it always renders: an empty tab says so instead of vanishing. */
export function RequestsPanel({ data }: { data: ContactCircles }) {
  const { themeStyle } = useMessengerUi();
  const t = useT();
  const { requests } = data;
  const total = openRequestCount(requests);

  const row = (r: ContactRequest, who: string, actions: ReactNode) => (
    <div key={r.id} className="circlesel__req" data-request-id={r.id} data-direction={r.direction}>
      <span className="circlesel__req-who">{who}</span>
      <span className="circlesel__req-acts">{actions}</span>
    </div>
  );

  return (
    <section className="circlesel circlesel__sec" data-panel="requests" data-sec="requests" style={themeStyle}>
      <h3 className="circlesel__h">
        {t('circles.requests')}
        <span className="circlesel__h-n">{total}</span>
      </h3>
      {total === 0 && <p className="circlesel__empty">{t('contacts.noRequests')}</p>}

      {requests.incoming.map((r) =>
        row(
          r,
          personTag(r.fromUser),
          <>
            <Button size="compact-xs" color="cyan" onClick={() => void data.actOnRequest(r.id, 'accept')}>
              {t('circles.accept')}
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => void data.actOnRequest(r.id, 'decline')}
            >
              {t('circles.decline')}
            </Button>
          </>,
        ),
      )}

      {requests.outgoing.map((r) =>
        row(
          r,
          personTag(r.toUser),
          <>
            {/* ADR-115 §2: ACCEPTED + parentApproval PENDING is "waiting for a parent", a real
                state of a live request, not a status of its own. */}
            {r.awaitingParent && <span className="circlesel__hit-state">{t('circles.awaitingParent')}</span>}
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => void data.actOnRequest(r.id, 'cancel')}
            >
              {t('circles.cancel')}
            </Button>
          </>,
        ),
      )}

      {requests.awaitingParent.length > 0 && <h4 className="circlesel__h is-sub">{t('circles.parentQueue')}</h4>}
      {requests.awaitingParent.map((r) =>
        row(
          r,
          `${personTag(r.fromUser)} → ${personTag(r.toUser)}`,
          <>
            <Button size="compact-xs" color="cyan" onClick={() => void data.actOnRequest(r.id, 'parent-approve')}>
              {t('circles.allow')}
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={() => void data.actOnRequest(r.id, 'parent-deny')}
            >
              {t('circles.deny')}
            </Button>
          </>,
        ),
      )}
    </section>
  );
}
