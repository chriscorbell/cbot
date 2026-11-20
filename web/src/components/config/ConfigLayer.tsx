import { useConfigUI } from '../../configStore';
import { AppSettings } from './AppSettings';
import { BotSettingsModal } from './BotSettingsModal';
import { Presence } from '../Presence';

/** Overlays owned by the settings feature: bot settings dialog and the app settings page. */
export function ConfigLayer() {
  const botSettings = useConfigUI((s) => !!s.botSettings);
  const appSettings = useConfigUI((s) => !!s.appSettings);
  return (
    <>
      <Presence show={appSettings}><AppSettings /></Presence>
      <Presence show={botSettings}><BotSettingsModal /></Presence>
    </>
  );
}
