/**
 * ThisDeviceSection: what the security sheet says about the device it is shown on (canon section 11).
 *
 * Two facts, each in the words of the threat rather than a reassurance: whether the encryption engine
 * runs apart from the page (a module Worker), and where the keys are kept. A browser says the canon's
 * web-fallback sentence in full (it hides keys from casual browsing only), because the web is a weaker
 * device and the product says so instead of pretending otherwise (canon section 3, step 4).
 */
import type { ThisDeviceSecurity } from '../../protocol/security-state.js';
import { useT } from '../provider/messenger-ui.js';

export interface ThisDeviceSectionProps {
  device: ThisDeviceSecurity;
}

export function ThisDeviceSection({ device }: ThisDeviceSectionProps) {
  const t = useT();
  return (
    <section
      className="msec-sheet__section msec-sheet__device"
      aria-label={t('thisDevice.heading')}
      data-engine-isolated={device.engineIsolated ? 'yes' : 'no'}
      data-key-store={device.keyStore}
    >
      <h5 className="msec-sheet__heading">{t('thisDevice.heading')}</h5>
      <p className="msec-sheet__note">
        {t(device.engineIsolated ? 'thisDevice.isolated' : 'thisDevice.notIsolated')}
      </p>
      <p className="msec-sheet__note">
        {t(device.keyStore === 'hardware' ? 'thisDevice.keysHardware' : 'thisDevice.keysBrowser')}
      </p>
    </section>
  );
}
