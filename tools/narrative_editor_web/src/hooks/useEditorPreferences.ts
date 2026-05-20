import { useCallback, useEffect, useState } from 'react';
import {
  applyEditorPreferences,
  DEFAULT_EDITOR_PREFERENCES,
  loadEditorPreferences,
  normalizeEditorPreferences,
  saveEditorPreferences,
  type EditorPreferences,
} from '../utils/editorPreferences';

export function useEditorPreferences() {
  const [preferences, setPreferencesState] = useState<EditorPreferences>(() => loadEditorPreferences());

  useEffect(() => {
    applyEditorPreferences(preferences);
    saveEditorPreferences(preferences);
  }, [preferences]);

  const setPreferences = useCallback((patch: Partial<EditorPreferences>) => {
    setPreferencesState((current) => normalizeEditorPreferences({ ...current, ...patch }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferencesState({ ...DEFAULT_EDITOR_PREFERENCES });
  }, []);

  return { preferences, setPreferences, resetPreferences };
}
