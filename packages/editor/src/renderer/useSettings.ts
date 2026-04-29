import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

// One source of truth for the app's persisted settings shape. New keys
// just need: a schema entry (with a sensible default), a row in the
// SettingsDialog form, and any consumer that reads `useSettings()`.
export const SettingsSchema = z.object({
  generatorServerUrl: z.string().default("http://localhost:8000"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

const STORAGE_KEY = "seam.settings";

function readFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    // Unrecognised / corrupt entries fall back to defaults rather than
    // throwing — better to lose a setting than to brick the editor.
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeToStorage(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota / disabled storage — non-fatal; the user just won't get
    // persistence this session.
  }
}

export interface UseSettings {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings>(() => readFromStorage());

  // Keep tabs / windows in sync. localStorage `storage` events fire on
  // *other* documents, so this is harmless within a single window.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setSettings(readFromStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = SettingsSchema.parse({ ...prev, ...patch });
      writeToStorage(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    writeToStorage(DEFAULT_SETTINGS);
  }, []);

  return { settings, updateSettings, resetSettings };
}
