import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITOR_PREFERENCES,
  fontFamilyStack,
  normalizeEditorPreferences,
} from './editorPreferences';

describe('editorPreferences', () => {
  it('normalizes out-of-range values', () => {
    const prefs = normalizeEditorPreferences({
      uiFontSize: 99,
      canvasLabelScale: 10,
      edgeLabelScale: 200,
      fontFamily: 'invalid' as never,
    });
    expect(prefs.uiFontSize).toBe(18);
    expect(prefs.canvasLabelScale).toBe(80);
    expect(prefs.edgeLabelScale).toBe(140);
    expect(prefs.fontFamily).toBe(DEFAULT_EDITOR_PREFERENCES.fontFamily);
  });

  it('resolves font stacks', () => {
    expect(fontFamilyStack('mono')).toContain('monospace');
    expect(fontFamilyStack('yahei')).toContain('Microsoft YaHei');
  });
});
