/**
 * SecuritySheetBody: what the zone badge opens. Plain words, in this order: what protects the room
 * (and what does not), who else sees it, and the security code to compare.
 *
 *  - The explanation is the zone's, never softer than the badge. In an encrypted room it also says
 *    the two things that are NOT hidden: media (not encrypted yet) and who talks to whom and when.
 *  - Guardians are listed for every member, the child included, with the line that it cannot be hidden.
 *  - The security code is the epoch authenticator. It is SHOWN, NOT ENFORCED: this screen offers it
 *    for two people to compare; nothing checks it for them, and the hint says so by asking the person.
 *  - Last, what THIS device can say about itself (canon section 11): whether the engine runs apart
 *    from the page and where the keys are kept, in the words of the threat. Shown only when the host
 *    knows it (`thisDevice`), so nothing is claimed by default.
 *
 * Drawn inside the host's menu (possibly in a portal), so the root carries the theme itself.
 */
import {
  epochAuthenticatorGroups,
  type ConversationSecurityState,
} from '../../protocol/security-state.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import { ThisDeviceSection } from './this-device-section.js';
import { distinctGuardians, explanationKeyOf, zoneOf, ZONE } from './zone.js';
import './security.css';

export interface SecuritySheetBodyProps {
  state: ConversationSecurityState;
}

export function SecuritySheetBody({ state }: SecuritySheetBodyProps) {
  const t = useT();
  const { themeStyle } = useMessengerUi();
  const zone = zoneOf(state);
  const guardians = distinctGuardians(state.guardians);

  return (
    <div className="msec-sheet" style={themeStyle} data-zone={zone}>
      <p className="msec-sheet__explain">{t(explanationKeyOf(state))}</p>
      {zone === ZONE.ENCRYPTED && (
        <>
          <p className="msec-sheet__note">{t('zone.mediaNote')}</p>
          <p className="msec-sheet__note">{t('zone.metadataNote')}</p>
        </>
      )}

      {guardians.length > 0 && (
        <section
          className="msec-sheet__section msec-sheet__guardians"
          aria-label={t('guardians.heading')}
        >
          <h5 className="msec-sheet__heading">{t('guardians.heading')}</h5>
          <ul className="msec-sheet__list">
            {guardians.map((guardian) => (
              <li key={guardian.userId}>
                {t('guardians.seesChat', { name: guardian.displayName })}
              </li>
            ))}
          </ul>
          <p className="msec-sheet__note">{t('guardians.cannotHide')}</p>
        </section>
      )}

      {state.e2ee === 'on' && (
        <section
          className="msec-sheet__section msec-sheet__code"
          aria-label={t('fingerprint.title')}
        >
          <h5 className="msec-sheet__heading">{t('fingerprint.title')}</h5>
          {state.epochAuthenticator ? (
            <>
              {/* The groups are laid out in a grid; the spaces between them stay in the text so a copy
                  of the code reads "A1B2 C3D4 …". `translate="no"`: a code is not prose. */}
              <p className="msec-code" translate="no" data-code={state.epochAuthenticator}>
                {epochAuthenticatorGroups(state.epochAuthenticator).map((group, index) => (
                  <span key={`${index}-${group}`} className="msec-code__group">
                    {group}{' '}
                  </span>
                ))}
              </p>
              {state.epoch !== undefined && (
                <p className="msec-sheet__note msec-sheet__epoch">
                  {t('fingerprint.epoch', { epoch: String(state.epoch) })}
                </p>
              )}
              <p className="msec-sheet__note msec-sheet__hint">{t('fingerprint.hint')}</p>
            </>
          ) : (
            <p className="msec-sheet__note">{t('fingerprint.unavailable')}</p>
          )}
        </section>
      )}

      {state.thisDevice && <ThisDeviceSection device={state.thisDevice} />}
    </div>
  );
}
