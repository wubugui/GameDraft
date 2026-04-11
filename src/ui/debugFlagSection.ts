import type { FlagStore, FlagValue } from '../core/FlagStore';
import type { EventBus } from '../core/EventBus';

const FAV_API = '/__gamedraft-api/debug-flag-favorites';

function normalizeFavoriteKeys(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map(x => String(x)).filter(Boolean))].slice(0, 64);
}

async function loadFavoritesFromFile(log: (message: string) => void): Promise<string[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const r = await fetch(FAV_API);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return normalizeFavoriteKeys(await r.json());
  } catch (e) {
    log(`Flag 收藏读取失败: ${String(e)}`);
    return [];
  }
}

function persistFavoritesToFile(keys: string[], log: (message: string) => void): void {
  if (!import.meta.env.DEV) {
    log('Flag 收藏仅能在 npm run dev 时写入 editor_data/debug_flag_favorites.json');
    return;
  }
  const body = JSON.stringify([...new Set(keys)].slice(0, 64));
  void (async () => {
    try {
      const r = await fetch(FAV_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      log(`Flag 收藏保存失败: ${String(e)}`);
    }
  })();
}

/** 子串匹配（任意位置），忽略大小写；非仅前缀匹配 */
function filterKeys(keys: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return keys;
  return keys.filter(k => k.toLowerCase().includes(q));
}

export interface DebugFlagSectionHandle {
  root: HTMLElement;
  destroy(): void;
  /** 从 editor_data/debug_flag_favorites.json 重新加载（仅开发服有数据） */
  syncFavoritesFromFile(): void;
}

export function createDebugFlagSection(
  flagStore: FlagStore,
  eventBus: EventBus,
  log: (message: string) => void,
): DebugFlagSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-dock__flag-section';

  const st = document.createElement('h3');
  st.className = 'debug-dock__section-title';
  st.textContent = 'Flag';
  sec.appendChild(st);

  const favTitle = document.createElement('div');
  favTitle.className = 'debug-flag__subhead';
  favTitle.textContent = import.meta.env.DEV
    ? '收藏（editor_data/debug_flag_favorites.json）'
    : '收藏（仅开发服持久化到仓库文件）';
  sec.appendChild(favTitle);

  const favList = document.createElement('div');
  favList.className = 'debug-flag__fav-list';
  sec.appendChild(favList);

  const searchLabel = document.createElement('label');
  searchLabel.className = 'debug-flag__label';
  searchLabel.textContent = '搜索（子串匹配，忽略大小写）';
  sec.appendChild(searchLabel);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'debug-flag__search';
  searchInput.placeholder = '任意片段…';
  searchInput.autocomplete = 'off';
  sec.appendChild(searchInput);

  const select = document.createElement('select');
  select.className = 'debug-flag__select';
  select.size = 10;
  sec.appendChild(select);

  const editor = document.createElement('div');
  editor.className = 'debug-flag__editor';

  const curLine = document.createElement('div');
  curLine.className = 'debug-flag__cur';
  const curKey = document.createElement('span');
  curKey.className = 'debug-flag__cur-key';
  const curVal = document.createElement('span');
  curVal.className = 'debug-flag__cur-val';
  curLine.appendChild(document.createTextNode('当前: '));
  curLine.appendChild(curKey);
  curLine.appendChild(document.createTextNode(' → '));
  curLine.appendChild(curVal);
  editor.appendChild(curLine);

  const boolRow = document.createElement('div');
  boolRow.className = 'debug-flag__btn-row';
  const btnTrue = document.createElement('button');
  btnTrue.type = 'button';
  btnTrue.className = 'debug-dock__btn';
  btnTrue.textContent = '设为 true';
  const btnFalse = document.createElement('button');
  btnFalse.type = 'button';
  btnFalse.className = 'debug-dock__btn';
  btnFalse.textContent = '设为 false';
  boolRow.appendChild(btnTrue);
  boolRow.appendChild(btnFalse);
  editor.appendChild(boolRow);

  const numRow = document.createElement('div');
  numRow.className = 'debug-flag__num-row';
  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.className = 'debug-flag__num';
  numInput.step = 'any';
  const btnApplyNum = document.createElement('button');
  btnApplyNum.type = 'button';
  btnApplyNum.className = 'debug-dock__btn';
  btnApplyNum.textContent = '应用数值';
  numRow.appendChild(numInput);
  numRow.appendChild(btnApplyNum);
  editor.appendChild(numRow);

  const strRow = document.createElement('div');
  strRow.className = 'debug-flag__str-row';
  const strInput = document.createElement('input');
  strInput.type = 'text';
  strInput.className = 'debug-flag__str';
  strInput.placeholder = '字符串值';
  const btnApplyStr = document.createElement('button');
  btnApplyStr.type = 'button';
  btnApplyStr.className = 'debug-dock__btn';
  btnApplyStr.textContent = '应用字符串';
  strRow.appendChild(strInput);
  strRow.appendChild(btnApplyStr);
  editor.appendChild(strRow);

  const favRow = document.createElement('div');
  favRow.className = 'debug-flag__btn-row';
  const btnAddFav = document.createElement('button');
  btnAddFav.type = 'button';
  btnAddFav.className = 'debug-dock__btn';
  btnAddFav.textContent = '加入收藏';
  const btnRmFav = document.createElement('button');
  btnRmFav.type = 'button';
  btnRmFav.className = 'debug-dock__btn';
  btnRmFav.textContent = '取消收藏';
  favRow.appendChild(btnAddFav);
  favRow.appendChild(btnRmFav);
  editor.appendChild(favRow);

  sec.appendChild(editor);

  let favorites: string[] = [];
  let allKeysCache: string[] = [];

  const formatVal = (v: FlagValue | undefined): string => {
    if (v === undefined) return '（未设置）';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  };

  const selectedKey = (): string => select.value.trim();

  const repopulateSelect = (): void => {
    allKeysCache = flagStore.getDebugPickableKeys();
    const filtered = filterKeys(allKeysCache, searchInput.value);
    const prev = selectedKey();
    select.replaceChildren();
    for (const k of filtered) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      select.appendChild(opt);
    }
    if (prev && filtered.includes(prev)) {
      select.value = prev;
    } else if (filtered.length > 0 && !select.value) {
      select.selectedIndex = 0;
    }
    refreshEditor();
  };

  const refreshFavorites = (): void => {
    favList.replaceChildren();
    const keys = favorites.filter(k => k.length > 0);
    if (keys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'debug-flag__hint';
      empty.textContent = import.meta.env.DEV
        ? '暂无。在下方选好键后点「加入收藏」（写入 editor_data/debug_flag_favorites.json）。'
        : '暂无。生产构建无法写回文件，请用 npm run dev 编辑收藏。';
      favList.appendChild(empty);
      return;
    }
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'debug-flag__fav-row';

      const name = document.createElement('span');
      name.className = 'debug-flag__fav-name';
      name.textContent = k;
      name.title = k;
      name.addEventListener('click', () => {
        searchInput.value = '';
        repopulateSelect();
        select.value = k;
        refreshEditor();
      });

      const val = document.createElement('span');
      val.className = 'debug-flag__fav-val';
      val.textContent = formatVal(flagStore.get(k));

      const kind = flagStore.getDebugValueKind(k);
      if (kind === 'string') {
        const si = document.createElement('input');
        si.type = 'text';
        si.className = 'debug-flag__fav-str';
        si.value = typeof flagStore.get(k) === 'string' ? (flagStore.get(k) as string) : '';
        const ap = document.createElement('button');
        ap.type = 'button';
        ap.className = 'debug-dock__btn debug-dock__btn--sm';
        ap.textContent = '应用';
        ap.addEventListener('click', () => {
          flagStore.set(k, si.value);
          log(`flag ${k} = ${JSON.stringify(si.value)}`);
          refreshFavorites();
          refreshEditor();
        });
        row.appendChild(name);
        row.appendChild(val);
        row.appendChild(si);
        row.appendChild(ap);
      } else if (kind === 'bool') {
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.className = 'debug-dock__btn debug-dock__btn--sm';
        b1.textContent = 'T';
        b1.title = 'true';
        b1.addEventListener('click', () => {
          flagStore.set(k, true);
          log(`flag ${k} = true`);
          refreshFavorites();
          refreshEditor();
        });
        const b0 = document.createElement('button');
        b0.type = 'button';
        b0.className = 'debug-dock__btn debug-dock__btn--sm';
        b0.textContent = 'F';
        b0.title = 'false';
        b0.addEventListener('click', () => {
          flagStore.set(k, false);
          log(`flag ${k} = false`);
          refreshFavorites();
          refreshEditor();
        });
        row.appendChild(name);
        row.appendChild(val);
        row.appendChild(b1);
        row.appendChild(b0);
      } else if (kind === 'float') {
        const ni = document.createElement('input');
        ni.type = 'number';
        ni.className = 'debug-flag__fav-num';
        ni.step = 'any';
        const cur = flagStore.get(k);
        ni.value = typeof cur === 'number' ? String(cur) : '0';
        const ap = document.createElement('button');
        ap.type = 'button';
        ap.className = 'debug-dock__btn debug-dock__btn--sm';
        ap.textContent = '应用';
        ap.addEventListener('click', () => {
          const n = Number(ni.value);
          if (!Number.isFinite(n)) {
            log(`flag ${k}: 无效数值`);
            return;
          }
          flagStore.set(k, n);
          log(`flag ${k} = ${n}`);
          refreshFavorites();
          refreshEditor();
        });
        row.appendChild(name);
        row.appendChild(val);
        row.appendChild(ni);
        row.appendChild(ap);
      }

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'debug-dock__btn debug-dock__btn--sm debug-dock__btn--danger';
      rm.textContent = '×';
      rm.title = '从收藏移除';
      rm.addEventListener('click', () => {
        favorites = favorites.filter(x => x !== k);
        persistFavoritesToFile(favorites, log);
        refreshFavorites();
      });
      row.appendChild(rm);

      favList.appendChild(row);
    }
  };

  const refreshEditor = (): void => {
    const k = selectedKey();
    curKey.textContent = k || '（未选）';
    const v = k ? flagStore.get(k) : undefined;
    curVal.textContent = formatVal(v);
    const kind = k ? flagStore.getDebugValueKind(k) : 'bool';
    boolRow.style.display = kind === 'bool' ? 'flex' : 'none';
    numRow.style.display = kind === 'float' ? 'flex' : 'none';
    strRow.style.display = kind === 'string' ? 'flex' : 'none';
    if (kind === 'float' && k) {
      numInput.value = typeof v === 'number' ? String(v) : '0';
    }
    if (kind === 'string' && k) {
      strInput.value = typeof v === 'string' ? v : '';
    }
  };

  searchInput.addEventListener('input', () => {
    repopulateSelect();
  });

  select.addEventListener('change', refreshEditor);

  btnTrue.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    flagStore.set(k, true);
    log(`flag ${k} = true`);
    refreshFavorites();
    refreshEditor();
  });

  btnFalse.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    flagStore.set(k, false);
    log(`flag ${k} = false`);
    refreshFavorites();
    refreshEditor();
  });

  btnApplyNum.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    const n = Number(numInput.value);
    if (!Number.isFinite(n)) {
      log('无效数值');
      return;
    }
    flagStore.set(k, n);
    log(`flag ${k} = ${n}`);
    refreshFavorites();
    refreshEditor();
  });

  btnApplyStr.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    flagStore.set(k, strInput.value);
    log(`flag ${k} = ${JSON.stringify(strInput.value)}`);
    refreshFavorites();
    refreshEditor();
  });

  btnAddFav.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    if (!favorites.includes(k)) favorites = [...favorites, k];
    persistFavoritesToFile(favorites, log);
    refreshFavorites();
    log(`已收藏: ${k}`);
  });

  btnRmFav.addEventListener('click', () => {
    const k = selectedKey();
    if (!k) return;
    favorites = favorites.filter(x => x !== k);
    persistFavoritesToFile(favorites, log);
    refreshFavorites();
    log(`已取消收藏: ${k}`);
  });

  const onFlagChanged = (): void => {
    allKeysCache = flagStore.getDebugPickableKeys();
    repopulateSelect();
    refreshFavorites();
    refreshEditor();
  };

  eventBus.on('flag:changed', onFlagChanged);

  repopulateSelect();
  refreshEditor();

  void (async () => {
    favorites = await loadFavoritesFromFile(log);
    refreshFavorites();
    refreshEditor();
  })();

  const syncFavoritesFromFile = (): void => {
    void (async () => {
      favorites = await loadFavoritesFromFile(log);
      refreshFavorites();
      refreshEditor();
    })();
  };

  return {
    root: sec,
    destroy(): void {
      eventBus.off('flag:changed', onFlagChanged);
      sec.replaceChildren();
    },
    syncFavoritesFromFile,
  };
}
