const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VALUE_BYTES = 64 * 1024 * 1024;
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

function validName(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new Error(`Invalid ${label}: expected 1-64 ASCII letters, digits, _ or -`);
  }
  return value;
}

function validValue(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new Error('Invalid store value: expected a string of at most 64 MiB');
  }
  return value;
}

async function assertDirectoryNotLink(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Store directory is not a regular directory: ${directory}`);
  }
}

async function writable(directory) {
  let probe;
  try {
    await fs.mkdir(directory, { recursive: true });
    await assertDirectoryNotLink(directory);
    probe = path.join(directory, `.write-probe-${process.pid}-${randomUUID()}`);
    const handle = await fs.open(probe, 'wx');
    try {
      await handle.writeFile('1');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  } finally {
    if (probe) await fs.rm(probe, { force: true }).catch(() => {});
  }
}

function createStore(app) {
  let rootPromise;
  const queues = new Map();

  async function root() {
    if (!rootPromise) {
      rootPromise = (async () => {
        const portable = path.join(path.dirname(app.getPath('exe')), 'gamedata');
        if (await writable(portable)) return portable;
        // Tauri's identifier is com.gamedraft.game, so preserve its AppData fallback.
        const fallback = path.join(app.getPath('appData'), 'com.gamedraft.game', 'gamedata');
        await fs.mkdir(fallback, { recursive: true });
        await assertDirectoryNotLink(fallback);
        if (!(await writable(fallback))) throw new Error(`Store root is not writable: ${fallback}`);
        console.warn(`[gamedata] Portable directory unavailable; using ${fallback}`);
        return fallback;
      })();
    }
    try {
      return await rootPromise;
    } catch (error) {
      rootPromise = null;
      throw error;
    }
  }

  async function namespaceDir(namespace, create) {
    validName(namespace, 'namespace');
    const directory = path.join(await root(), namespace);
    if (create) await fs.mkdir(directory, { recursive: true });
    try {
      await assertDirectoryNotLink(directory);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
    return directory;
  }

  async function keyPath(namespace, key, create) {
    validName(key, 'key');
    const directory = await namespaceDir(namespace, create);
    return directory && path.join(directory, `${key}.json`);
  }

  function serial(namespace, key, operation) {
    validName(namespace, 'namespace');
    validName(key, 'key');
    const queueKey = `${namespace}/${key}`;
    const prior = queues.get(queueKey) || Promise.resolve();
    const running = prior.catch(() => {}).then(operation);
    const settled = running.then(() => {}, () => {});
    queues.set(queueKey, settled);
    void settled.then(() => {
      if (queues.get(queueKey) === settled) queues.delete(queueKey);
    });
    return running;
  }

  async function renameWithRetry(source, target) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(source, target);
        return;
      } catch (error) {
        if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
  }

  return {
    root,
    async readAll(namespace) {
      const directory = await namespaceDir(namespace, false);
      if (!directory) return {};
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const result = {};
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const key = entry.name.slice(0, -5);
        if (!NAME.test(key)) continue;
        try {
          result[key] = await fs.readFile(path.join(directory, entry.name), 'utf8');
        } catch (error) {
          console.error(`[gamedata] Cannot read ${entry.name}:`, error);
        }
      }
      return result;
    },
    write(namespace, key, value) {
      validValue(value);
      return serial(namespace, key, async () => {
        const target = await keyPath(namespace, key, true);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporary, 'wx');
          try {
            await handle.writeFile(value.endsWith('\n') ? value : `${value}\n`, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await renameWithRetry(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
    },
    remove(namespace, key) {
      return serial(namespace, key, async () => {
        const target = await keyPath(namespace, key, false);
        if (target) await fs.rm(target, { force: true });
      });
    },
  };
}

module.exports = { createStore };
