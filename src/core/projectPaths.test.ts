import {
  MEDIA_URLS,
  TEXT_URLS,
  isMediaUrl,
  isTextUrl,
  mediaUrlForRoot,
  mediaUrlFromShortPath,
  sceneJsonUrl,
  sceneRuntimeAssetUrl,
  sceneRuntimeDirUrl,
} from './projectPaths';

describe('projectPaths text/media split', () => {
  it('exposes assets-only constants for text/config', () => {
    expect(TEXT_URLS.dataDir).toBe('/assets/data');
    expect(TEXT_URLS.scenesDir).toBe('/assets/scenes');
    expect(TEXT_URLS.dialoguesDir).toBe('/assets/dialogues');
    expect(TEXT_URLS.filtersDir).toBe('/assets/data/filters');
    expect(TEXT_URLS.gameConfig).toBe('/assets/data/game_config.json');
    expect(TEXT_URLS.overlayImages).toBe('/assets/data/overlay_images.json');
  });

  it('exposes runtime-only constants for media', () => {
    expect(MEDIA_URLS.imagesDir).toBe('/resources/runtime/images');
    expect(MEDIA_URLS.audioDir).toBe('/resources/runtime/audio');
    expect(MEDIA_URLS.animationDir).toBe('/resources/runtime/animation');
    expect(MEDIA_URLS.scenesDir).toBe('/resources/runtime/scenes');
    expect(MEDIA_URLS.illustrationsDir).toBe('/resources/runtime/images/illustrations');
    expect(MEDIA_URLS.backgroundsDir).toBe('/resources/runtime/images/backgrounds');
  });

  it('isMediaUrl recognises runtime urls only', () => {
    expect(isMediaUrl('/resources/runtime/images/x.png')).toBe(true);
    expect(isMediaUrl('resources/runtime/images/x.png')).toBe(true);
    expect(isMediaUrl('/assets/data/x.json')).toBe(false);
    expect(isMediaUrl('')).toBe(false);
  });

  it('isTextUrl recognises assets urls only', () => {
    expect(isTextUrl('/assets/data/x.json')).toBe(true);
    expect(isTextUrl('assets/data/x.json')).toBe(true);
    expect(isTextUrl('/resources/runtime/audio/x.wav')).toBe(false);
  });
});

describe('sceneJsonUrl / sceneRuntimeAssetUrl', () => {
  it('scene json sits under assets', () => {
    expect(sceneJsonUrl('码头白天')).toBe('/assets/scenes/码头白天.json');
  });

  it('scene runtime dir sits under runtime', () => {
    expect(sceneRuntimeDirUrl('码头白天')).toBe('/resources/runtime/scenes/码头白天');
  });

  it('short ref joins under scene runtime dir', () => {
    expect(sceneRuntimeAssetUrl('码头白天', 'background.png')).toBe(
      '/resources/runtime/scenes/码头白天/background.png',
    );
    expect(sceneRuntimeAssetUrl('码头白天', 'raw_depth_rg.png')).toBe(
      '/resources/runtime/scenes/码头白天/raw_depth_rg.png',
    );
  });

  it('full runtime url is returned verbatim', () => {
    expect(
      sceneRuntimeAssetUrl(
        'ignored',
        '/resources/runtime/images/illustrations/码头人群1.png',
      ),
    ).toBe('/resources/runtime/images/illustrations/码头人群1.png');
  });

  it('warns but passes through assets-rooted url for media (lenient, keeps legacy data loadable)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sceneRuntimeAssetUrl('s', '/assets/images/x.png')).toBe('/assets/images/x.png');
    expect(sceneRuntimeAssetUrl('s', 'assets/images/x.png')).toBe('assets/images/x.png');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('throws on empty inputs', () => {
    expect(() => sceneJsonUrl('')).toThrow();
    expect(() => sceneRuntimeDirUrl('')).toThrow();
    expect(() => sceneRuntimeAssetUrl('s', '')).toThrow();
  });
});

describe('mediaUrlFromShortPath', () => {
  it('joins short ref under runtime images by default', () => {
    expect(mediaUrlFromShortPath('images/backgrounds/back_alley_dock_bg.png')).toBe(
      '/resources/runtime/images/backgrounds/back_alley_dock_bg.png',
    );
    expect(mediaUrlFromShortPath('images/illustrations/码头人群1.png')).toBe(
      '/resources/runtime/images/illustrations/码头人群1.png',
    );
  });

  it('passes through full runtime url', () => {
    const url = '/resources/runtime/images/minigames/water/x.png';
    expect(mediaUrlFromShortPath(url)).toBe(url);
  });

  it('rejects assets-rooted media url', () => {
    expect(() => mediaUrlFromShortPath('/assets/images/x.png')).toThrow();
    expect(() => mediaUrlFromShortPath('assets/images/x.png')).toThrow();
  });

  it('rejects unknown absolute url', () => {
    expect(() => mediaUrlFromShortPath('/foo/bar.png')).toThrow();
  });
});

describe('mediaUrlForRoot', () => {
  it('joins ref under explicit media subroot', () => {
    expect(mediaUrlForRoot('images', 'backgrounds/x.png')).toBe(
      '/resources/runtime/images/backgrounds/x.png',
    );
    expect(mediaUrlForRoot('audio', 'bgm/y.wav')).toBe(
      '/resources/runtime/audio/bgm/y.wav',
    );
    expect(mediaUrlForRoot('animation', 'player_anim/anim.json')).toBe(
      '/resources/runtime/animation/player_anim/anim.json',
    );
    expect(mediaUrlForRoot('scenes', '码头白天/background.png')).toBe(
      '/resources/runtime/scenes/码头白天/background.png',
    );
  });

  it('passes through full runtime url', () => {
    expect(mediaUrlForRoot('images', '/resources/runtime/images/x.png')).toBe(
      '/resources/runtime/images/x.png',
    );
  });

  it('rejects assets-rooted media url', () => {
    expect(() => mediaUrlForRoot('images', '/assets/images/x.png')).toThrow();
    expect(() => mediaUrlForRoot('audio', 'assets/audio/x.wav')).toThrow();
  });
});
