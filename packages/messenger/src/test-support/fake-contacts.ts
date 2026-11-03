/**
 * Plain contact data for the channel-bank tests: Masia-less on purpose (the assistant is just the
 * contact with `isAi`, as far as the bank is concerned).
 */
import type { MessengerContact } from '../contacts/contact-model.js';
import type { EntityType } from '../protocol/conversations.js';

export const assistantContact: MessengerContact = {
  key: 'masia',
  kind: 'MASIA',
  entityType: 'USER' as EntityType,
  id: 'masia',
  name: 'Assistant',
  avatarUrl: null,
  isAi: true,
};

export const familyContact: MessengerContact = {
  key: 'family',
  kind: 'FAMILY',
  entityType: 'FAMILY' as EntityType,
  id: 'family',
  name: 'Family',
  avatarUrl: null,
  isAi: false,
};

export function personContact(i: number): MessengerContact {
  return {
    key: `u_${i}`,
    kind: 'CONTACT',
    entityType: 'USER' as EntityType,
    id: String(i),
    name: `Person ${i}`,
    avatarUrl: null,
    isAi: false,
  };
}

/** The assistant, the family, then `n` people (recent by default). */
export function contactsOf(n: number): MessengerContact[] {
  return [assistantContact, familyContact, ...Array.from({ length: n }, (_, i) => personContact(i))];
}
