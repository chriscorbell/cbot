import { engineFor, refreshEngines } from './engine.js';
import { putSettings, SECRETS, type SettingKey } from './settings.js';
import { errorText } from './lib/errors.js';

/**
 * Saves Settings > Providers: each value given is set, and '' removes it. Every gateway restarts on the
 * result: now if no run is using it, else once the last one is done (engine.ts holdGateway). A secret's
 * old value leaves every home that still holds it. Returns whether anything changed.
 */
export function saveProviderSettings(patch: Partial<Record<SettingKey, string>>): boolean {
  const changed = putSettings(patch);
  if (!changed.size) return false;
  const removed = SECRETS.filter((s) => changed.get(s.id)).map((s) => ({ env: s.env, value: changed.get(s.id)! }));
  for (const id of refreshEngines(removed)) {
    engineFor(id).catch((e: unknown) => console.warn(`[engine] ${id}: restart for new provider settings failed: ${errorText(e)}`));
  }
  return true;
}
