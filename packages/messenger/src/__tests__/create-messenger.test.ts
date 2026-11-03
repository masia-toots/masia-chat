import { readFileSync } from 'node:fs';
import {
  createFakeAuthSession,
  createFakeI18nBundle,
  createFakeIconSet,
  createFakeMediaUpload,
  createFakeContactsDirectory,
  createFakePushBridge,
  createFakeRichAttachment,
  createFakeSecureStorage,
  createFakeThemeTokens,
  createFakeTransport,
} from '@masia/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { createMessenger, MESSENGER_VERSION, type MessengerPorts } from '../index.js';

function createFakePorts(): MessengerPorts {
  return {
    auth: createFakeAuthSession(),
    transport: createFakeTransport(),
    storage: createFakeSecureStorage(),
    push: createFakePushBridge(),
    directory: createFakeContactsDirectory(),
    theme: createFakeThemeTokens(),
    icons: createFakeIconSet(),
    i18n: createFakeI18nBundle(),
    media: createFakeMediaUpload(),
    attachments: createFakeRichAttachment(),
  };
}

describe('createMessenger', () => {
  it('returns the package version and keeps the ports it was given', () => {
    const ports = createFakePorts();
    const messenger = createMessenger(ports);
    expect(messenger.version).toBe(MESSENGER_VERSION);
    expect(messenger.ports).toBe(ports);
  });

  it('keeps MESSENGER_VERSION equal to package.json (one fact, two homes, one test)', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: MESSENGER_VERSION });
  });
});
