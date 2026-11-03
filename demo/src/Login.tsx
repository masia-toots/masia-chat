import { useState, type FormEvent } from 'react';
import { Button, TextInput } from '@mantine/core';
import { DISPLAY_NAME_MAX } from '../shared/paths.js';

// The whole sign-in: a name. There is no password and no account; the server hands a relay token to
// whoever asks (see the README). A reload is a new person, which is also how the second tab joins.

export interface LoginProps {
  onJoin(name: string): void;
  busy: boolean;
  error: string | undefined;
  /** False when the browser has no WebCrypto (an address that is not localhost or https). */
  cryptoAvailable: boolean;
}

export function Login({ onJoin, busy, error, cryptoAvailable }: LoginProps) {
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '' && !busy) onJoin(name);
  };
  return (
    <main className="demo-login">
      <form className="demo-login__card" onSubmit={submit}>
        <h1 className="demo-login__title">Messenger playground</h1>
        <p className="demo-login__lead">
          Pick a name. Then open this page in a second tab, pick another name, and talk to yourself:
          two tabs are two people, and what they say to each other is end-to-end encrypted.
        </p>
        <TextInput
          label="Your name"
          placeholder="Ada"
          value={name}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(event) => setName(event.currentTarget.value)}
          autoFocus
          autoComplete="off"
          data-testid="login-name"
        />
        {!cryptoAvailable && (
          <p className="demo-login__error" role="alert">
            This browser has no WebCrypto here. Open the page at http://localhost or over https.
          </p>
        )}
        {error && (
          <p className="demo-login__error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={name.trim() === '' || !cryptoAvailable} data-testid="login-join">
          Join
        </Button>
        <p className="demo-login__note">
          Nothing is saved. Reloading a tab makes you a new person, and the keys exist only in that tab.
        </p>
      </form>
    </main>
  );
}
