import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useContactCircles } from '@masia/messenger/contacts';
import { MessengerChatView, PeoplePanel, ZoneBadge } from '@masia/messenger/ui';
import type { PlaygroundRuntime } from './client/runtime.js';
import { statusLineOf } from './client/status.js';
import { useRoomMessenger } from './client/use-room-messenger.js';
import type { PeopleDirectory } from './host/people-directory.js';
import { PersonChip } from './host/slots.js';
import type { Toaster } from './host/toaster.js';

// The page after sign-in: who I am, who else is here, the chats this tab has, and the open chat. The
// people list and the chat view are the messenger's own screens; this file only places them.

export interface ShellProps {
  runtime: PlaygroundRuntime;
  directory: PeopleDirectory;
  toaster: Toaster;
}

export function Shell({ runtime, directory, toaster }: ShellProps) {
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const book = useContactCircles({ directory });
  const [active, setActive] = useState<string | null>(null);
  const toasts = useSyncExternalStore(toaster.subscribe, toaster.getSnapshot);

  // Someone joined or left: the address book reads the new list.
  const { reload } = book;
  useEffect(() => {
    directory.setPeople(view.people);
    void reload();
  }, [directory, view.people, reload]);

  const open = useCallback(
    (peerUserId: string) => setActive(runtime.open(peerUserId)),
    [runtime],
  );
  const activeChat = view.chats.find((chat) => chat.conversationId === active);
  const peerName = activeChat?.peerName ?? '';

  return (
    <div className={`demo-shell${active ? ' has-chat' : ''}`}>
      <aside className="demo-side" aria-label="People and chats">
        <header className="demo-me">
          <PersonChip name={view.self.displayName} kind="HUMAN" />
          <div className="demo-me__text">
            <strong data-testid="me-name">{view.self.displayName}</strong>
            <span>this tab</span>
          </div>
        </header>
        {view.problem !== undefined && (
          <p className="demo-problem" role="alert">
            The playground server does not answer: {view.problem}
          </p>
        )}
        <section className="demo-side__section" aria-label="Open chats">
          <h2 className="demo-side__title">Chats</h2>
          {view.chats.length === 0 ? (
            <p className="demo-side__empty">None yet. Open this page in a second tab, then pick the other person below.</p>
          ) : (
            <ul className="demo-chats">
              {view.chats.map((chat) => (
                <li key={chat.conversationId}>
                  <button
                    type="button"
                    className={`demo-chats__row${chat.conversationId === active ? ' is-active' : ''}`}
                    onClick={() => setActive(chat.conversationId)}
                    data-peer={chat.peerName}
                  >
                    <PersonChip name={chat.peerName} kind="HUMAN" />
                    <span className="demo-chats__name">{chat.peerName}</span>
                    {chat.unread > 0 && <span className="demo-chats__badge">{chat.unread}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="demo-side__section" aria-label="People">
          <h2 className="demo-side__title">People</h2>
          <PeoplePanel data={book} onOpenContact={open} autoFocusSearch={false} />
        </section>
      </aside>

      <main className="demo-main">
        {active === null ? (
          <div className="demo-main__idle">
            <p>Pick a person to start an encrypted chat.</p>
          </div>
        ) : (
          <ChatPane
            key={active}
            runtime={runtime}
            toaster={toaster}
            conversationId={active}
            peerName={peerName}
            onBack={() => setActive(null)}
          />
        )}
      </main>

      <div className="demo-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="demo-toast" role="status">
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ChatPaneProps {
  runtime: PlaygroundRuntime;
  toaster: Toaster;
  conversationId: string;
  peerName: string;
  onBack(): void;
}

function ChatPane({ runtime, toaster, conversationId, peerName, onBack }: ChatPaneProps) {
  const messenger = useRoomMessenger(runtime, conversationId, { notifyError: toaster.push });
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const room = view.chats.find((chat) => chat.conversationId === conversationId)?.room;
  const status = statusLineOf(room);
  const count = messenger.messages.length;

  // Looking at the chat reads it: the badge in the list goes away as messages arrive.
  useEffect(() => {
    runtime.markSeen(conversationId);
  }, [runtime, conversationId, count]);

  return (
    <div className="demo-chat" data-testid="chat-pane">
      <header className="demo-chat__head">
        <button type="button" className="demo-chat__back" onClick={onBack} aria-label="Back to the list">
          ‹
        </button>
        <PersonChip name={peerName} kind="HUMAN" />
        <strong className="demo-chat__name">{peerName}</strong>
        <ZoneBadge conversationId={conversationId} />
      </header>
      {status !== null && (
        <p className="demo-chat__status" role="status" data-testid="chat-status">
          {status}
        </p>
      )}
      <MessengerChatView
        messenger={messenger}
        currentPersonId={view.self.userId}
        isGroup={false}
        isPrivate
        conversationId={conversationId}
      />
    </div>
  );
}
