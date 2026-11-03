/**
 * A test vector of the signed device-list format `mls-device-list/v1` (canon §3), produced ONCE with
 * the client's own helpers — `generateIdentityKeyPair`, `signDeviceList`, `deviceListSigningBytes`
 * and checked with `verifyDeviceList` (`@masia/messenger/mls`, `src/mls/device-list.ts`) — and copied
 * here as data. The relay may not import the client, not even in a test (the open-messenger boundary,
 * `pnpm boundary`: relay-imports-only-contracts), so the vector is the meeting point: the relay test
 * stores each version through the HTTP route (which itself verifies `signature` under the pinned
 * `identityKeyPub` before it stores anything), reads it back and proves the served rows rebuild exactly
 * `signingBytes`, under which `signature` verifies with `identityKeyPub` (Ed25519). The shared
 * encoder (`deviceListSigningBytes` in `@masia/contracts/wire`) must reproduce `signingBytes` too, so
 * the client and the relay cannot drift apart on the canonical bytes.
 *
 * Regenerate if the format changes (a new format tag is a new vector, never an edit of this one).
 */
export const DEVICE_LIST_V1_FORMAT = 'mls-device-list/v1';

export const DEVICE_LIST_V1_VECTOR = {
  person: {
    userId: 'alice',
    identityKeyPub: 'Ld2QULjGB06oGay/alE1mEq+4DWSS5FwRPtQiFA/bpE=',
    versions: [
      {
        version: 1,
        devices: [
          {
            id: 'alice-phone',
            role: 'USER',
            signatureKey: 'S003rWTlQAT30vFBy1wtezXzny0zgyGSb01M1xTL0pY=',
          },
        ],
        signature:
          '2GiBoMWpPxOKestYl4w+et5Cmz7nqbB/8CFokevax0VkRJQ65FM27WcGBQ+nqBmlP28pYlN8Ucqju37TchQNAg==',
        signingBytes:
          '{"format":"mls-device-list/v1","userId":"alice","version":1,"devices":[{"id":"alice-phone","role":"USER","signatureKey":"S003rWTlQAT30vFBy1wtezXzny0zgyGSb01M1xTL0pY="}]}',
      },
      {
        version: 2,
        devices: [
          {
            id: 'alice-phone',
            role: 'USER',
            signatureKey: 'S003rWTlQAT30vFBy1wtezXzny0zgyGSb01M1xTL0pY=',
          },
          {
            id: 'alice-laptop',
            role: 'USER',
            signatureKey: 'mD4bXY6z/G6aUhyIKicaUCg/ZaSs7543JT2fVr/Sw2g=',
          },
        ],
        signature:
          '9e+2Z4LxWTOvs6J3ee+OziXOtiRdf5T0LVUZtbH0wwtoz20K6cEfH3tlwCthSlxXmHJOVFeX9pl70QK017oWCg==',
        signingBytes:
          '{"format":"mls-device-list/v1","userId":"alice","version":2,"devices":[{"id":"alice-laptop","role":"USER","signatureKey":"mD4bXY6z/G6aUhyIKicaUCg/ZaSs7543JT2fVr/Sw2g="},{"id":"alice-phone","role":"USER","signatureKey":"S003rWTlQAT30vFBy1wtezXzny0zgyGSb01M1xTL0pY="}]}',
      },
    ],
  },
  operator: {
    userId: 'test-operator',
    identityKeyPub: 'i+4P3iq23lEgcdhiwqt+PUoDjnJYf7kHewycu6qlE9s=',
    versions: [
      {
        version: 1,
        devices: [
          {
            id: 'assistant-room-1',
            role: 'ASSISTANT',
            signatureKey: 'aJd+ERqLBKM9mHa7uti8uZvXhxnUw7kCZ+R0VZbTnwM=',
            conversationId: 'room-1',
          },
        ],
        signature:
          'Vx4PZulx3abuGU55cXFCdsANsI2W/Wt5v4V5VATGOelV6hR0CINSAc+oOKfr/Ne6sIi8kTMhwCypnsuqlicjAw==',
        signingBytes:
          '{"format":"mls-device-list/v1","userId":"test-operator","version":1,"devices":[{"id":"assistant-room-1","role":"ASSISTANT","signatureKey":"aJd+ERqLBKM9mHa7uti8uZvXhxnUw7kCZ+R0VZbTnwM=","conversationId":"room-1"}]}',
      },
    ],
  },
} as const;
