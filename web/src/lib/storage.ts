import { PROJECT_NAME } from "./brand";

// Read the former keys only to migrate returning users' preferences.
const LEGACY_KEYS = { view: "accrue.view", wallet: "accrue.wallet" } as const;
type Preference = keyof typeof LEGACY_KEYS;

export function readPreference(preference: Preference): string | null {
  try {
    const value = localStorage.getItem(`${PROJECT_NAME}.${preference}`) ?? localStorage.getItem(LEGACY_KEYS[preference]);
    if (value !== null) savePreference(preference, value);
    return value;
  } catch {
    return null;
  }
}

export function savePreference(preference: Preference, value: string | null): void {
  try {
    const key = `${PROJECT_NAME}.${preference}`;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    localStorage.removeItem(LEGACY_KEYS[preference]);
  } catch {
    /* Storage unavailable: preferences and connections won't be remembered. */
  }
}
