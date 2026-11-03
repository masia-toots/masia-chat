import { useEffect, useMemo, useState } from 'react';
import { MessengerUiProvider } from '@masia/messenger/ui';
import { parseSeedContacts, type SeedContact } from '@masia/messenger/contacts';
import { DEMO_PATHS } from '../shared/paths.js';
import { startRuntime, type PlaygroundRuntime } from './client/runtime.js';
import { langFromSearch } from './host/lang.js';
import { createPeopleDirectory, type PeopleDirectory } from './host/people-directory.js';
import { createServices } from './host/services.js';
import { createToaster, type Toaster } from './host/toaster.js';
import { Login } from './Login.js';
import { Shell } from './Shell.js';

// The page's root: a sign-in form, then the shell. The seed contacts (who to write to when nobody else
// is here) come from the server's `contacts.json`, so a host edits one file and the page follows.

type Phase =
  | { readonly kind: 'login'; readonly error?: string }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'ready';
      readonly runtime: PlaygroundRuntime;
      readonly directory: PeopleDirectory;
      readonly toaster: Toaster;
    };

const START_ERRORS: Readonly<Record<string, string>> = {
  BAD_NAME: 'Please type a name: letters, digits and spaces, a few words at most.',
};

function startErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return START_ERRORS[code] ?? 'Could not join. Is the playground server running? Check the terminal.';
}

function useSeedContacts(): readonly SeedContact[] {
  const [seeds, setSeeds] = useState<readonly SeedContact[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(DEMO_PATHS.contacts)
      .then((response) => (response.ok ? response.json() : []))
      .then((raw: unknown) => {
        if (alive) setSeeds(parseSeedContacts(raw));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return seeds;
}

export function App() {
  const lang = useMemo(() => langFromSearch(window.location.search), []);
  const seeds = useSeedContacts();
  const [phase, setPhase] = useState<Phase>({ kind: 'login' });
  const cryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle !== undefined;

  const join = (name: string) => {
    setPhase({ kind: 'starting' });
    startRuntime({ name })
      .then((runtime) =>
        setPhase({ kind: 'ready', runtime, directory: createPeopleDirectory(), toaster: createToaster() }),
      )
      .catch((error: unknown) => setPhase({ kind: 'login', error: startErrorText(error) }));
  };

  // The messenger's services are rebuilt only when the runtime or the seeds change.
  const services = useMemo(
    () =>
      phase.kind === 'ready'
        ? createServices({ runtime: phase.runtime, toaster: phase.toaster, lang, seeds })
        : undefined,
    [phase, lang, seeds],
  );

  if (phase.kind !== 'ready' || services === undefined) {
    return (
      <Login
        onJoin={join}
        busy={phase.kind === 'starting'}
        error={phase.kind === 'login' ? phase.error : undefined}
        cryptoAvailable={cryptoAvailable}
      />
    );
  }
  return (
    <MessengerUiProvider services={services}>
      <Shell runtime={phase.runtime} directory={phase.directory} toaster={phase.toaster} />
    </MessengerUiProvider>
  );
}
