const fs = require('node:fs');
const path = require('node:path');

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const CLOUD_NAME = /^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64})?\.json$/;
const OVERLAY_DIALOGS = Object.freeze({
  friends: 0, community: 1, players: 2, settings: 3,
  officialGameGroup: 4, stats: 5, achievements: 6,
});

function positiveAppId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) {
    throw new Error('Steam AppID must be a positive uint32');
  }
  return id;
}

function readConfig(app) {
  // SteamAPI_Init must run before app.ready. process.execPath is available at
  // module load time and points at the same executable as app.getPath('exe').
  const configPath = path.join(path.dirname(process.execPath), 'steam_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object') throw new Error('steam_config.json must be an object');
    return {
      appId: positiveAppId(config.appId),
      restartThroughSteam: config.restartThroughSteam === true,
      source: 'steam_config.json',
    };
  }
  // Explicit test override also works with a green build, but cannot replace
  // the AppID carried by a production steam_config.json.
  if (process.env.GAMEDRAFT_STEAM_APP_ID) {
    return { appId: positiveAppId(process.env.GAMEDRAFT_STEAM_APP_ID), restartThroughSteam: false, source: 'dev-env' };
  }
  const launchAppId = process.env.SteamAppId || process.env.SteamGameId;
  return launchAppId
    ? { appId: positiveAppId(launchAppId), restartThroughSteam: false, source: 'steam-env' }
    : { appId: null, restartThroughSteam: false, source: 'steam-client' };
}

function checkIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`Invalid Steam ${label}`);
  return value;
}

function checkCloudName(value) {
  if (typeof value !== 'string' || !CLOUD_NAME.test(value)) {
    throw new Error('Invalid cloud filename; use name.json or namespace/name.json');
  }
  return value;
}

function requireSuccess(value, operation) {
  if (value !== true) throw new Error(`Steam ${operation} failed`);
}

function createSteamService(app) {
  let sdk = null;
  let client = null;
  let appId = null;
  let source = null;
  let reason = null;
  let overlayHookInstalled = false;
  let restarted = false;

  try {
    sdk = require('steamworks.js');
    // This must happen before app.ready / BrowserWindow: the helper installs
    // in-process GPU + disables DirectComposition for Electron's Steam overlay.
    sdk.electronEnableSteamOverlay();
    overlayHookInstalled = true;
  } catch (error) {
    reason = `Steam native module / overlay hook unavailable: ${error.message}`;
  }

  function initialize() {
    if (!sdk || !overlayHookInstalled) return false;
    try {
      const config = readConfig(app);
      appId = config.appId;
      source = config.source;
      if (config.restartThroughSteam && app.isPackaged && appId !== null && sdk.restartAppIfNecessary(appId)) {
        restarted = true;
        reason = 'Steam is restarting the game through its client';
        return false;
      }
      // The caller runs this synchronously before app.ready and BrowserWindow.
      client = appId === null ? sdk.init() : sdk.init(appId);
      appId = client.utils.getAppId();
      reason = null;
      return true;
    } catch (error) {
      reason = `Steam initialization failed: ${error.message}`;
      client = null;
      return false;
    }
  }

  function status() {
    return {
      available: client !== null,
      appId,
      source,
      reason,
      overlaySupported: client !== null && overlayHookInstalled,
      overlayHookInstalled,
      overlayVisible: null, // steamworks.js 0.4.0 cannot query actual visibility.
      overlayRepaintWorkaroundActive: overlayHookInstalled,
      overlayGpuMode: overlayHookInstalled ? 'in-process; direct-composition-disabled' : null,
      restartedThroughSteam: restarted,
    };
  }

  function ready() {
    if (!client) throw new Error(reason || 'Steam is unavailable');
    return client;
  }

  function cloudReady() {
    const c = ready();
    if (!c.cloud.isEnabledForAccount() || !c.cloud.isEnabledForApp()) {
      throw new Error('Steam Cloud is disabled for this account or app');
    }
    return c.cloud;
  }

  return {
    initialize,
    status,
    shouldExitForSteam: () => restarted,
    identity() {
      if (!client) return null;
      const id = client.localplayer.getSteamId();
      return {
        steamId64: id.steamId64.toString(),
        name: client.localplayer.getName(),
        level: client.localplayer.getLevel(),
        language: client.apps.currentGameLanguage(),
      };
    },
    activateOverlay(dialog) {
      if (!Object.hasOwn(OVERLAY_DIALOGS, dialog)) throw new Error('Invalid Steam overlay dialog');
      ready().overlay.activateDialog(OVERLAY_DIALOGS[dialog]);
      // A successful call does not prove that the overlay appeared onscreen.
    },
    achievement: {
      isActivated(id) {
        return ready().achievement.isActivated(checkIdentifier(id, 'achievement ID'));
      },
      activate(id) {
        const c = ready();
        requireSuccess(c.achievement.activate(checkIdentifier(id, 'achievement ID')), 'achievement activate');
        requireSuccess(c.stats.store(), 'achievement store');
      },
      clear(id) {
        const c = ready();
        requireSuccess(c.achievement.clear(checkIdentifier(id, 'achievement ID')), 'achievement clear');
        requireSuccess(c.stats.store(), 'achievement store');
      },
    },
    stats: {
      getInt(name) {
        return ready().stats.getInt(checkIdentifier(name, 'stat name'));
      },
      setInt(name, value) {
        checkIdentifier(name, 'stat name');
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
          throw new Error('Steam integer stat must fit int32');
        }
        requireSuccess(ready().stats.setInt(name, value), 'stats setInt');
      },
      store() {
        requireSuccess(ready().stats.store(), 'stats store');
      },
    },
    cloud: {
      status() {
        if (!client) return { available: false, enabledForAccount: false, enabledForApp: false, reason };
        return {
          available: true,
          enabledForAccount: client.cloud.isEnabledForAccount(),
          enabledForApp: client.cloud.isEnabledForApp(),
          reason: null,
        };
      },
      list() {
        return cloudReady().listFiles().map(file => ({ name: file.name, size: file.size.toString() }));
      },
      read(name) {
        const cloud = cloudReady();
        checkCloudName(name);
        return cloud.fileExists(name) ? cloud.readFile(name) : null;
      },
      write(name, value) {
        checkCloudName(name);
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024 * 1024) {
          throw new Error('Invalid Steam Cloud value');
        }
        requireSuccess(cloudReady().writeFile(name, value), 'cloud write');
      },
      remove(name) {
        checkCloudName(name);
        const cloud = cloudReady();
        if (cloud.fileExists(name)) requireSuccess(cloud.deleteFile(name), 'cloud remove');
      },
    },
    dlc: {
      isInstalled(id) {
        return ready().apps.isDlcInstalled(positiveAppId(id));
      },
    },
  };
}

module.exports = { createSteamService };
