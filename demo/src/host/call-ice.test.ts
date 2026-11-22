import { describe, expect, it } from 'vitest';
import { callIceAnswer, ICE_LOOPBACK, ICE_NO_ROUTE, isLoopbackHost } from './call-ice.js';

describe('the ICE route of a call in the playground', () => {
  it('knows the names of this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', 'demo.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['192.168.1.20', '10.0.0.2', 'relay', 'example.org', 'localhost.example.org', '128.0.0.1', '::1', '']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('lets two tabs of a page on this machine connect directly, with no server of any kind', () => {
    for (const page of ['http://localhost:8080/', 'http://demo.localhost:8080/', 'http://127.0.0.1:8080/', 'http://[::1]:8080/']) {
      const answer = callIceAnswer(page);
      expect(answer, page).toEqual(ICE_LOOPBACK);
      expect(answer.iceTransportPolicy).toBe('all');
      expect(answer.iceServers).toEqual([]);
    }
  });

  it('gives no route at all when the page is anywhere else, so the call fails out loud', () => {
    for (const page of ['http://192.168.1.20:8080/', 'https://demo.example.org/', 'http://localhost.example.org/', 'not a url']) {
      const answer = callIceAnswer(page);
      expect(answer, page).toEqual(ICE_NO_ROUTE);
      // Relay-only with no server: the engine ends the answered call as `relay-unavailable` before it makes a peer connection.
      expect(answer.iceTransportPolicy).toBe('relay');
      expect(answer.iceServers).toEqual([]);
    }
  });

  it('never names a STUN or TURN server, whatever the route', () => {
    for (const answer of [ICE_LOOPBACK, ICE_NO_ROUTE]) {
      expect(answer.iceServers.flatMap((server) => server.urls)).toEqual([]);
    }
  });
});
