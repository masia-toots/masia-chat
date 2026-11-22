/**
 * ADR-215 step 1 (track access): what the call engine lends the Masia layer of a verified call, and nothing more.
 *
 *   • `localTrack()` — the call's own echo-cancelled microphone track, for a capture tap that must never open a second
 *     microphone (decision 10). Null until the call is verified, and once it is over.
 *   • `replaceOutboundTrack(track)` — the mixing graph's track on the call's sender in place of the microphone
 *     (decision 11); `null` puts the plain microphone back. Only in a verified call. A replacement that fails puts
 *     the microphone back; if even that fails, the call ends — nothing half-built stays on the line.
 */
import { describe, expect, it } from 'vitest';
import { CALL, CERT_B, callerToTags, fakeTrack, peerTag, settle, setup } from './call-engine-support.js';

/** Caller, DTLS up with the callee's real certificate on the shared transport, tags checked: `verified`. */
async function verifiedCall() {
  const h = setup();
  await callerToTags(h);
  h.peer().presentCertificate(CERT_B);
  h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
  await settle();
  expect(h.state().name).toBe('verified');
  return h;
}

const asTrack = (t: ReturnType<typeof fakeTrack>): MediaStreamTrack => t as unknown as MediaStreamTrack;

describe('the call engine lends its tracks to Masia only in a verified call (ADR-215 decisions 10 and 11)', () => {
  it('localTrack(): nothing before the call is verified; the call’s own microphone track once it is; nothing after it ends', async () => {
    const h = setup();
    expect(h.engine.localTrack()).toBeNull();
    await callerToTags(h);
    expect(h.state().name).not.toBe('verified');
    expect(h.engine.localTrack()).toBeNull();
    h.peer().presentCertificate(CERT_B);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.engine.localTrack()).toBe(h.micTrack);
    expect(h.microphone).toHaveBeenCalledTimes(1); // the tap reads this track: no second microphone
    h.engine.hangUp();
    expect(h.engine.localTrack()).toBeNull();
  });

  it('replaceOutboundTrack(): refused before the call is verified — the sender is not touched', async () => {
    const h = setup();
    await callerToTags(h);
    const graph = fakeTrack();
    expect(await h.engine.replaceOutboundTrack(asTrack(graph))).toBe(false);
    expect(h.peer().replaced).toEqual([]);
  });

  it('replaceOutboundTrack(): the graph’s track goes on the call’s sender; `null` puts the plain microphone back', async () => {
    const h = await verifiedCall();
    const graph = fakeTrack();
    expect(await h.engine.replaceOutboundTrack(asTrack(graph))).toBe(true);
    expect(h.peer().replaced).toEqual([graph]);
    expect(await h.engine.replaceOutboundTrack(null)).toBe(true);
    expect(h.peer().replaced).toEqual([graph, h.micTrack]);
    expect(h.state().name).toBe('verified');
  });

  it('swaps run one after another, in the order asked: a quick put-back is never overtaken', async () => {
    const h = await verifiedCall();
    const graph = fakeTrack();
    const results = await Promise.all([h.engine.replaceOutboundTrack(asTrack(graph)), h.engine.replaceOutboundTrack(null)]);
    expect(results).toEqual([true, true]);
    expect(h.peer().replaced).toEqual([graph, h.micTrack]);
  });

  it('🔴 a replacement that fails puts the microphone back (step 1: «restores the microphone after an error»)', async () => {
    const h = await verifiedCall();
    h.peer().replaceFails = 1;
    expect(await h.engine.replaceOutboundTrack(asTrack(fakeTrack()))).toBe(false);
    expect(h.peer().replaced).toEqual([h.micTrack]);
    expect(h.state().name).toBe('verified');
  });

  it('🔴 …and if the microphone cannot be put back either, the call ends: nothing half-built stays on the line', async () => {
    const h = await verifiedCall();
    const peer = h.peer();
    peer.replaceFails = 2;
    expect(await h.engine.replaceOutboundTrack(asTrack(fakeTrack()))).toBe(false);
    expect(h.state().name).toBe('ended');
    expect(peer.closed).toBe(true);
    expect(h.socket.of('call:end').at(-1)?.payload).toEqual({ callId: CALL, reason: 'connect-failed' });
  });

  it('mute still holds the microphone while the graph is on the sender (the graph reads that same track)', async () => {
    const h = await verifiedCall();
    const graph = fakeTrack();
    await h.engine.replaceOutboundTrack(asTrack(graph));
    h.engine.setMuted(true);
    expect(h.micTrack.enabled).toBe(false);
    expect(graph.enabled).toBe(true); // the graph is the Masia layer's: it takes the microphone out itself (decision 7)
    h.engine.setMuted(false);
    expect(h.micTrack.enabled).toBe(true);
  });

  it('after the call: nothing is swapped, and the graph’s track is left to its owner (only the microphone is stopped)', async () => {
    const h = await verifiedCall();
    const graph = fakeTrack();
    await h.engine.replaceOutboundTrack(asTrack(graph));
    const peer = h.peer();
    h.engine.hangUp();
    expect(await h.engine.replaceOutboundTrack(asTrack(fakeTrack()))).toBe(false);
    expect(peer.replaced).toEqual([graph]);
    expect(h.micTrack.stopped).toBe(true);
    expect(graph.stopped).toBe(false);
  });
});
