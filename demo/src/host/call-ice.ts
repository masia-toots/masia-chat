import type { CallIceAnswer } from '@masia/messenger/call';

// The ICE route of a call in the playground. There is no TURN server and no STUN server here, on purpose:
// a STUN server would tell a third party both people's public addresses, and a TURN server is a service
// someone has to run and trust. Without either, the only path two browsers can find is a direct one
// between their own host addresses, which works between two tabs of one machine.
//
// So the route depends on where the PAGE runs:
//   - the page is on this machine (a loopback address): every candidate type, no servers; the two tabs
//     reach each other directly;
//   - anything else: the relay-only policy with no servers. The engine then refuses the call as
//     `relay-unavailable` and says so on the screen, rather than leaking a direct path across a network
//     nobody vetted.
//
// Only the page is checked. The page reaches the relay through its own server's `/relay` door, so the
// relay's address as the page sees it is always the page's own; where that server forwards to
// (DEMO_RELAY_URL) is not visible here and is not checked. Whoever runs that relay sees the call's
// signals: who calls whom, both addresses and every SDP.

/** `localhost` and its subdomains (RFC 6761 keeps them on this machine, where the resolver honours it). */
const LOCALHOST = /^(?:.+\.)?localhost$/i;
/** The whole IPv4 loopback block, 127.0.0.0/8. */
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
/** The IPv6 loopback, as `URL.hostname` writes it (in brackets). */
const IPV6_LOOPBACK = '[::1]';

/** Whether a URL's hostname names this machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOCALHOST.test(hostname) || IPV4_LOOPBACK.test(hostname) || hostname === IPV6_LOOPBACK;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** No servers, every candidate type: the direct path between two tabs of one machine. */
export const ICE_LOOPBACK: CallIceAnswer = { status: 'NOT_CONFIGURED', iceServers: [], iceTransportPolicy: 'all' };
/** No servers, relay candidates only: no path at all, which the engine reports as `relay-unavailable`. */
export const ICE_NO_ROUTE: CallIceAnswer = { status: 'NOT_CONFIGURED', iceServers: [], iceTransportPolicy: 'relay' };

/** The answer for every call of a page, from the page's absolute URL. */
export function callIceAnswer(pageUrl: string): CallIceAnswer {
  const page = hostOf(pageUrl);
  return page !== null && isLoopbackHost(page) ? ICE_LOOPBACK : ICE_NO_ROUTE;
}
