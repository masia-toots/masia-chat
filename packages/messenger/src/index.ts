import type {
  AuthSession,
  ContactsDirectory,
  I18nBundle,
  IconSet,
  MediaUpload,
  PushBridge,
  RichAttachment,
  SecureStorage,
  ThemeTokens,
  Transport,
} from '@masia/contracts';

/** Kept equal to `package.json` `version` by a test, not by memory. */
export const MESSENGER_VERSION = '0.0.1';

/**
 * Everything the messenger needs from the world around it, and nothing more.
 *
 * Why: the messenger is an open package that must run in any host. It never imports the host's
 * auth, network, storage, theme or i18n; the host hands in an implementation of each port
 * (`@masia/contracts`) and the messenger works through those alone.
 */
export interface MessengerPorts {
  auth: AuthSession;
  transport: Transport;
  storage: SecureStorage;
  push: PushBridge;
  directory: ContactsDirectory;
  theme: ThemeTokens;
  icons: IconSet;
  i18n: I18nBundle;
  media: MediaUpload;
  attachments: RichAttachment;
}

/**
 * A running messenger. Stub for now: it carries its version and the ports it was built with;
 * the MLS core, client state and UI core land in later steps (see `docs/canon.md`).
 */
export interface Messenger {
  readonly version: string;
  readonly ports: MessengerPorts;
}

/** Builds a messenger bound to the host's ports. */
export function createMessenger(ports: MessengerPorts): Messenger {
  return { version: MESSENGER_VERSION, ports };
}
