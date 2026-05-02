import {
  entityCutsceneIds,
  hasCutsceneBinding,
  isCutsceneOnlyEntity,
  isEntityBoundToCutscene,
  isSharedCutsceneEntity,
} from './types';

describe('cutscene entity binding helpers', () => {
  it('treats cutsceneIds as the only binding source and defaults bound entities to cutscene-only', () => {
    const regular = {};
    const cutsceneOnly = { cutsceneIds: ['intro', 'dock'] };
    const shared = { cutsceneIds: ['intro'], cutsceneOnly: false };

    expect(entityCutsceneIds(regular)).toEqual([]);
    expect(hasCutsceneBinding(regular)).toBe(false);
    expect(isCutsceneOnlyEntity(regular)).toBe(false);

    expect(entityCutsceneIds(cutsceneOnly)).toEqual(['intro', 'dock']);
    expect(isEntityBoundToCutscene(cutsceneOnly, 'dock')).toBe(true);
    expect(isCutsceneOnlyEntity(cutsceneOnly)).toBe(true);
    expect(isSharedCutsceneEntity(cutsceneOnly)).toBe(false);

    expect(isEntityBoundToCutscene(shared, 'intro')).toBe(true);
    expect(isCutsceneOnlyEntity(shared)).toBe(false);
    expect(isSharedCutsceneEntity(shared)).toBe(true);
  });
});
