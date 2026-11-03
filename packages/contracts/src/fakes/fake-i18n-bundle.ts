import type { I18nBundle, MessengerI18nKey, MessengerLang } from '../ports/i18n-bundle.js';

/**
 * English strings for every messenger key. Typed as a full record, so adding a key to
 * `MESSENGER_I18N_KEYS` fails to compile here until the fake has a sentence for it.
 */
export const FAKE_I18N_STRINGS: Readonly<Record<MessengerI18nKey, string>> = {
  'epoch.deviceAdded': '{{name}} added a device: {{device}}',
  'epoch.encryptionOn': 'Encryption is on; earlier history was deleted',
  'epoch.deviceRemoved': '{{name}} removed a device: {{device}}',
  'epoch.masiaJoined': 'Masia joined the room',
  'epoch.masiaLeft': 'Masia left the room',
  'epoch.keyChanged': '{{name}}’s security key changed — compare security codes',
  'zone.encrypted': 'Text is encrypted · media we can read',
  'zone.masia': 'Masia zone — the server reads this room',
  'zone.pending': 'Setting up encryption…',
  'zone.plain': 'Not end-to-end encrypted',
  'zone.sheetTitle': 'Security of this room',
  'zone.explainEncrypted':
    'Text messages here are end-to-end encrypted: only the devices of the people in this room can read them. Masia is not a member.',
  'zone.explainMasiaServer':
    'The server can read this chat: Masia needs the text to remember and to help. This is not end-to-end encryption.',
  'zone.explainMasiaMember':
    'Masia is a member of this room and her key is kept on our server, so the server can read what is said from the moment she joined. This is not end-to-end encryption.',
  'zone.explainPending':
    'Encryption is still being set up for this room. Until the badge changes, do not treat this chat as end-to-end encrypted.',
  'zone.explainPlain': 'The server can read this chat. It is not end-to-end encrypted yet.',
  'zone.mediaNote': 'Photos and files are not end-to-end encrypted yet: the server can read them.',
  'zone.metadataNote': 'The server always sees who talks to whom and when.',
  'zone.openDevices': 'Devices in this room',
  'guardians.heading': 'Guardians in this room',
  'guardians.seesChat': '{{name}} sees this chat',
  'guardians.seesChatMany': '{{count}} adults see this chat',
  'guardians.cannotHide': 'This cannot be hidden: everyone in the room sees it.',
  'fingerprint.title': 'Security code',
  'fingerprint.hint':
    'Compare this code with the other person, in person or on a call. If it differs, do not trust this room.',
  'fingerprint.epoch': 'Key version {{epoch}}',
  'fingerprint.unavailable': 'The security code is not available yet.',
  'recovery.stalled':
    'This room is waiting for a key refresh — messages will arrive once it completes.',
  'thisDevice.heading': 'This device',
  'thisDevice.isolated':
    'The encryption engine runs apart from this page: the room’s keys are never in the page’s memory.',
  'thisDevice.notIsolated':
    'The encryption engine runs inside this page: a script in the page could reach the room’s keys.',
  'thisDevice.keysHardware':
    'Keys are kept in this phone’s hardware-backed store, on this device only.',
  'thisDevice.keysBrowser':
    'Keys are kept in this browser. That hides them from casual browsing only: it protects neither a copy of the disk nor against a malicious script in this page. For anything sensitive, use the phone.',
  'roomState.sending': 'Sending… what you write now goes out right after.',
  'roomState.readOnly':
    'This chat is open in another tab of this browser. This tab is paused; close the other one to continue here.',
  'roomState.removed':
    'This device was removed from the chat. What it already showed stays; nothing new arrives here.',
  'roomState.historyGap': 'History before {{date}} is on your other devices.',
  'roomState.signIn':
    'This device is signed out of encrypted chats. Sign in again to read and send.',
  'composer.placeholder': 'Write a message',
  'composer.send': 'Send',
  // chat
  'chat.deletedPreview': 'Message deleted',
  'chat.react': 'React',
  'chat.copy': 'Copy',
  'chat.edit': 'Edit',
  'chat.delete': 'Delete',
  'chat.edited': 'edited',
  'chat.messageActions': 'Message actions',
  'chat.messageActionsClose': 'Close',
  'chat.privateEmpty': 'Private chat — just the two of you.',
  'chat.startChat': 'Say hello 👋',
  'chat.editingMessage': 'Editing message',
  'chat.sticker': 'Sticker',
  // common
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.create': 'Create',
  'common.save': 'Save',
  'common.scrollPrev': 'Scroll left',
  'common.scrollNext': 'Scroll right',
  'common.loading': 'Searching…',
  // bank
  'bank.channels': 'Channels',
  'bank.lockedChannel': 'Available in the full version',
  'bank.pinned': 'Pinned',
  'bank.recent': 'Recent',
  // circles
  'circles.title': 'Circles',
  'circles.family': 'Family',
  'circles.namePlaceholder': 'Circle name',
  'circles.editCircle': 'Edit circle',
  'circles.rename': 'Rename',
  'circles.delete': 'Delete circle',
  'circles.suggestFriends': 'Friends',
  'circles.suggestStudy': 'Study',
  'circles.suggestWork': 'Work',
  'circles.suggestGeneral': 'General',
  'circles.inCircle': 'In this circle',
  'circles.familyMembers': 'In the family',
  'circles.notInCircle': 'Other contacts',
  'circles.circleEmpty': 'Nobody in this circle yet — add someone below.',
  'circles.openChat': 'Open chat',
  'circles.addToCircle': 'Add to circle',
  'circles.removeFromCircle': 'Remove from circle',
  'circles.noHits': 'Nobody found with that tag.',
  'circles.sendRequest': 'Send request',
  'circles.alreadyContact': 'Already a contact',
  'circles.requestSent': 'Request sent',
  'circles.awaitingParent': 'Waiting for a parent',
  'circles.wantsYou': 'Waiting for your answer',
  'circles.requests': 'Requests',
  'circles.accept': 'Accept',
  'circles.decline': 'Decline',
  'circles.cancel': 'Cancel',
  'circles.parentQueue': 'Waiting for a parent',
  'circles.allow': 'Allow',
  'circles.deny': 'Deny',
  'circles.externalBadge': 'from another family',
  'circles.errMemberIsFamily':
    'They are already family — that membership lives in the family profile.',
  'circles.errNotAContact': 'Become contacts first — send a request.',
  'circles.errToggleFailed': 'Could not change the «Family» circle.',
  // contacts
  'contacts.people': 'People',
  'contacts.newRequests': '{{count}} new requests',
  'contacts.noRequests': 'No requests.',
  'contacts.searchPlaceholder': 'Name or @tag',
  'contacts.searchLabel': 'Find a person',
  'contacts.all': 'All',
  'contacts.addCircle': '＋ circle',
  'contacts.mine': 'Mine',
  'contacts.newByTag': 'New, by @tag',
  'contacts.noContacts': 'No contacts yet — find someone by @tag.',
  'contacts.noneMatch': 'None of mine match.',
  'contacts.pinOne': 'Pin',
  'contacts.unpin': 'Unpin',
  'contacts.pinAlways': 'From another family — stays pinned while you’re contacts',
  // groups
  'groups.title': 'Groups',
  'groups.none': 'No groups yet — build the first one from contacts in any circle.',
  'groups.add': '+ new group',
  'groups.namePlaceholder': 'Group name',
  'groups.editGroup': 'Edit group',
  'groups.rename': 'Rename',
  'groups.leave': 'Leave group',
  'groups.delete': 'Delete group',
  'groups.members': 'Members',
  'groups.inGroup': 'Who is in the group',
  'groups.memberOnly': 'Only a group admin can change the roster.',
  'groups.otherContacts': 'Other contacts',
  'groups.noContacts': 'No contacts yet — find someone by @tag under Search.',
  'groups.openChat': 'Open the group chat',
  // devices
  'devices.section': 'Devices',
  'devices.desc':
    'Where you are signed in. If a row looks unfamiliar, log it out — that device loses access immediately.',
  'devices.empty': 'No active sessions.',
  'devices.memberEmpty': 'This member has no active sessions.',
  'devices.current': 'current',
  'devices.unknown': 'Unknown device',
  'devices.lastSeen': 'Last seen {{when}}',
  'devices.revoke': 'Log out',
  'devices.revokeConfirm': 'Log out “{{name}}”? That device loses access immediately.',
  'devices.revokeError': 'Could not log that device out.',
  'devices.loadError': 'Could not load the device list.',
  'devices.platform.ios': 'iOS',
  'devices.platform.android': 'Android',
  'devices.platform.web': 'Browser',
  'devices.role.USER': 'Person',
  'devices.role.GUARDIAN': 'Guardian',
  'devices.role.ASSISTANT': 'Assistant',
  'devices.verified': 'Verified',
  'devices.unverified': 'Not verified',
  'devices.needsSelfUpdate': 'Waiting for this device’s first key update',
  'devices.roomSection': 'Devices in this room',
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** In-memory `I18nBundle`; an unsupplied placeholder is left visible, never silently blanked. */
export function createFakeI18nBundle(lang: MessengerLang = 'en'): I18nBundle {
  return {
    lang,
    t(key, vars) {
      return FAKE_I18N_STRINGS[key].replace(PLACEHOLDER, (marker, name: string) => {
        const value = vars?.[name];
        return value === undefined ? marker : String(value);
      });
    },
  };
}
