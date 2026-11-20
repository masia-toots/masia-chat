/** The languages the messenger ships text for. */
export const MESSENGER_LANGS = ['uk', 'en', 'de'] as const;
export type MessengerLang = (typeof MESSENGER_LANGS)[number];

/**
 * Every string key the messenger UI asks for. The keys live in the messenger package; a host that
 * already runs an i18n library mounts them as a `messenger.*` namespace, so `zone.encrypted` is
 * `messenger.zone.encrypted` there.
 *
 * Grouped by the screen that asks (`chat` conversation · `bank` channel bank · `contacts`/`circles`/
 * `groups` the people menu · `devices` the sessions card · `common` shared verbs · `zone`/
 * `guardians`/`fingerprint`/`recovery`/`epoch` the security state of a room · `thisDevice` what this
 * device can honestly say about its own protection · `roomState` a room's live E2EE state). A key that takes
 * `count` is a plural: the host resolves the form for its language, the fake has one English line.
 * A key no screen asks for does not belong here: every one is a sentence each host must translate.
 */
export const MESSENGER_I18N_KEYS = [
  'epoch.deviceAdded',
  'epoch.encryptionOn',
  // K5b: the security-state UI (zone badge, guardian ribbon, fingerprint, stall banner, epoch lines).
  'epoch.deviceRemoved',
  'epoch.masiaJoined',
  'epoch.masiaLeft',
  'epoch.keyChanged',
  'zone.encrypted',
  'zone.masia',
  'zone.pending',
  'zone.plain',
  'zone.sheetTitle',
  'zone.explainEncrypted',
  'zone.explainMasiaServer',
  'zone.explainMasiaMember',
  'zone.explainPending',
  'zone.explainPlain',
  'zone.mediaNote',
  'zone.metadataNote',
  'zone.openDevices',
  'guardians.heading',
  'guardians.seesChat',
  'guardians.seesChatMany',
  'guardians.cannotHide',
  'fingerprint.title',
  'fingerprint.hint',
  'fingerprint.epoch',
  'fingerprint.unavailable',
  'recovery.stalled',
  // K8: what this device says about its own protection (security sheet) and a room live state (strip).
  'thisDevice.heading',
  'thisDevice.isolated',
  'thisDevice.notIsolated',
  'thisDevice.keysHardware',
  'thisDevice.keysBrowser',
  'roomState.sending',
  'roomState.readOnly',
  'roomState.removed',
  'roomState.historyGap',
  'roomState.signIn',
  'composer.placeholder',
  'composer.send',
  // chat
  'chat.deletedPreview',
  'chat.react',
  'chat.copy',
  'chat.edit',
  'chat.delete',
  'chat.edited',
  'chat.messageActions',
  'chat.messageActionsClose',
  'chat.privateEmpty',
  'chat.startChat',
  // A message of mine that never left, and the way to send it again.
  'chat.notSent',
  'chat.retrySend',
  'chat.editingMessage',
  'chat.sticker',
  // The name of a picture's thumbnail as a button that opens the viewer («Open picture 2»; `n` is its place in its message).
  'chat.openImage',
  // the reply intent (internal ADR-199 §1–2): the menu row, the strip above the composer, a deleted parent
  'chat.reply',
  'chat.replyingTo',
  'chat.replyDeleted',
  // ADR-199 §5: the @-mention popover's name and the assistant's row in it.
  'chat.mentionHint',
  'chat.masiaName',
  // ADR-201: the two rows that call the room (`@all`, `@online`), offered only in a group of three or more.
  'chat.mentionAll',
  'chat.mentionOnline',
  // common
  'common.cancel',
  'common.close',
  'common.create',
  'common.save',
  'common.scrollPrev',
  'common.scrollNext',
  'common.loading',
  // bank
  'bank.channels',
  'bank.lockedChannel',
  // ADR-201 (chat-attention К2): a chip's unread mark, said in words for the accessible name (plurals: `count`).
  'bank.unread',
  'bank.unreadMentions',
  'bank.muted',
  // polishing П16: the delimiter before another family's people — «Інша родина» (+ the family's name), and the group's name in words.
  'bank.otherFamily',
  'bank.otherFamilyNamed',
  // circles
  'circles.title',
  'circles.family',
  'circles.namePlaceholder',
  'circles.editCircle',
  'circles.rename',
  'circles.delete',
  'circles.suggestFriends',
  'circles.suggestStudy',
  'circles.suggestWork',
  'circles.suggestGeneral',
  'circles.inCircle',
  'circles.familyMembers',
  'circles.notInCircle',
  'circles.circleEmpty',
  'circles.openChat',
  'circles.addToCircle',
  'circles.removeFromCircle',
  'circles.noHits',
  'circles.sendRequest',
  'circles.alreadyContact',
  'circles.requestSent',
  'circles.awaitingParent',
  'circles.wantsYou',
  'circles.requests',
  'circles.accept',
  'circles.decline',
  'circles.cancel',
  'circles.parentQueue',
  'circles.allow',
  'circles.deny',
  'circles.externalBadge',
  'circles.errMemberIsFamily',
  'circles.errNotAContact',
  'circles.errToggleFailed',
  // contacts
  'contacts.people',
  'contacts.noRequests',
  'contacts.searchPlaceholder',
  'contacts.searchLabel',
  'contacts.all',
  'contacts.addCircle',
  'contacts.mine',
  'contacts.newByTag',
  'contacts.noContacts',
  'contacts.noneMatch',
  'contacts.pinOne',
  'contacts.unpin',
  'contacts.pinAlways',
  // groups
  'groups.title',
  'groups.none',
  'groups.add',
  'groups.namePlaceholder',
  'groups.editGroup',
  'groups.rename',
  'groups.leave',
  'groups.delete',
  'groups.members',
  'groups.inGroup',
  'groups.memberOnly',
  'groups.otherContacts',
  'groups.noContacts',
  'groups.openChat',
  // devices
  'devices.section',
  'devices.desc',
  'devices.empty',
  'devices.memberEmpty',
  'devices.current',
  'devices.unknown',
  'devices.lastSeen',
  'devices.revoke',
  'devices.revokeConfirm',
  'devices.revokeError',
  'devices.loadError',
  'devices.platform.ios',
  'devices.platform.android',
  'devices.platform.web',
  'devices.role.USER',
  'devices.role.GUARDIAN',
  'devices.role.ASSISTANT',
  'devices.verified',
  'devices.unverified',
  'devices.needsSelfUpdate',
  'devices.roomSection',
] as const;
export type MessengerI18nKey = (typeof MESSENGER_I18N_KEYS)[number];

/**
 * Translated strings for the messenger UI.
 *
 * Why: the messenger must not import the host's i18n package or assume its library. It asks for a
 * key and gets a finished sentence; `vars` fills named placeholders (`{{name}}`).
 */
export interface I18nBundle {
  t(key: MessengerI18nKey, vars?: Record<string, string | number>): string;
  readonly lang: MessengerLang;
}
