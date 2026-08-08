/**
 * F2「场景」页：跳到任意一个场景。
 *
 * 清单来源优先开发服 `/__gamedraft-api/scene-list`（枚举 public/assets/scenes 全部 JSON），
 * 拿不到时退回调用方给的兜底清单（地图节点 + game_config 入口/回退 + dev_room）——
 * 兜底只覆盖玩家可走的节点，梦境/演出/测试场景不在其中，会在页内明说。
 */

const SCENE_LIST_API = '/__gamedraft-api/scene-list';

export interface DebugSceneEntry {
  id: string;
  name: string;
  /** 场景 JSON 的 spawnPoints 键；无则空数组（走场景默认 spawnPoint） */
  spawnPoints: string[];
}

export interface DebugSceneSectionDeps {
  getCurrentSceneId: () => string | undefined;
  /** 真正换场景（走 SceneManager.switchScene 那条正路，不是 reload） */
  jump: (sceneId: string, spawnPoint?: string) => void;
  /** 开发服接口不可用时的兜底清单 */
  listFallback: () => Promise<DebugSceneEntry[]>;
  /** 订阅换场景（用于跳完后刷新「当前」行与 ● 标记）；返回退订函数 */
  onSceneChanged: (callback: () => void) => () => void;
  log: (message: string) => void;
}

export interface DebugSceneSectionHandle {
  root: HTMLElement;
  /** 重新取清单并重绘（打开面板时调一次，改了场景 JSON 不必刷页面） */
  refresh(): void;
  destroy(): void;
}

function normalizeEntries(data: unknown): DebugSceneEntry[] {
  const scenes = (data as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  const out: DebugSceneEntry[] = [];
  for (const raw of scenes) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as { id?: unknown; name?: unknown; spawnPoints?: unknown };
    const id = String(rec.id ?? '').trim();
    if (!id) continue;
    const name = String(rec.name ?? '').trim() || id;
    const spawnPoints = Array.isArray(rec.spawnPoints)
      ? rec.spawnPoints.map((s) => String(s)).filter(Boolean)
      : [];
    out.push({ id, name, spawnPoints });
  }
  return out;
}

/** 子串匹配 id 与显示名，忽略大小写 */
function filterEntries(entries: DebugSceneEntry[], query: string): DebugSceneEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
  );
}

export function createDebugSceneSection(deps: DebugSceneSectionDeps): DebugSceneSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-scene__section';

  const title = document.createElement('h3');
  title.className = 'debug-dock__section-title';
  title.textContent = '场景跳转';
  sec.appendChild(title);

  const cur = document.createElement('div');
  cur.className = 'debug-flag__cur';
  const curName = document.createElement('span');
  curName.className = 'debug-flag__cur-key';
  cur.appendChild(document.createTextNode('当前: '));
  cur.appendChild(curName);
  sec.appendChild(cur);

  const searchLabel = document.createElement('label');
  searchLabel.className = 'debug-flag__label';
  searchLabel.textContent = '搜索（场景名或 id，子串匹配）';
  sec.appendChild(searchLabel);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'debug-flag__search';
  searchInput.placeholder = '任意片段…';
  searchInput.autocomplete = 'off';
  sec.appendChild(searchInput);

  const select = document.createElement('select');
  select.className = 'debug-flag__select debug-scene__select';
  select.size = 12;
  sec.appendChild(select);

  const spawnLabel = document.createElement('label');
  spawnLabel.className = 'debug-flag__label';
  spawnLabel.textContent = '出生点（spawnPoint）';
  sec.appendChild(spawnLabel);

  const spawnSelect = document.createElement('select');
  spawnSelect.className = 'debug-flag__select debug-scene__spawn';
  sec.appendChild(spawnSelect);

  const btnRow = document.createElement('div');
  btnRow.className = 'debug-flag__btn-row';
  const btnGo = document.createElement('button');
  btnGo.type = 'button';
  btnGo.className = 'debug-dock__btn';
  btnGo.textContent = '跳转';
  const btnReloadCurrent = document.createElement('button');
  btnReloadCurrent.type = 'button';
  btnReloadCurrent.className = 'debug-dock__btn';
  btnReloadCurrent.textContent = '重进当前场景';
  const btnRefresh = document.createElement('button');
  btnRefresh.type = 'button';
  btnRefresh.className = 'debug-dock__btn';
  btnRefresh.textContent = '刷新清单';
  btnRow.appendChild(btnGo);
  btnRow.appendChild(btnReloadCurrent);
  btnRow.appendChild(btnRefresh);
  sec.appendChild(btnRow);

  const hint = document.createElement('p');
  hint.className = 'debug-flag__hint';
  sec.appendChild(hint);

  let entries: DebugSceneEntry[] = [];
  let fromFallback = false;
  let destroyed = false;

  const selectedEntry = (): DebugSceneEntry | undefined =>
    entries.find((e) => e.id === select.value);

  const repopulateSpawn = (): void => {
    const entry = selectedEntry();
    const prev = spawnSelect.value;
    spawnSelect.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '（场景默认）';
    spawnSelect.appendChild(def);
    for (const sp of entry?.spawnPoints ?? []) {
      const opt = document.createElement('option');
      opt.value = sp;
      opt.textContent = sp;
      spawnSelect.appendChild(opt);
    }
    spawnSelect.value = entry?.spawnPoints.includes(prev) ? prev : '';
  };

  const repopulateSelect = (): void => {
    const filtered = filterEntries(entries, searchInput.value);
    const prev = select.value;
    const currentId = deps.getCurrentSceneId();
    select.replaceChildren();
    for (const e of filtered) {
      const opt = document.createElement('option');
      opt.value = e.id;
      const mark = e.id === currentId ? '● ' : '';
      opt.textContent = e.name === e.id ? `${mark}${e.id}` : `${mark}${e.name}　(${e.id})`;
      opt.title = e.id;
      select.appendChild(opt);
    }
    if (prev && filtered.some((e) => e.id === prev)) select.value = prev;
    else if (currentId && filtered.some((e) => e.id === currentId)) select.value = currentId;
    else if (filtered.length > 0) select.selectedIndex = 0;
    repopulateSpawn();
  };

  const refreshHeader = (): void => {
    const id = deps.getCurrentSceneId();
    const entry = entries.find((e) => e.id === id);
    curName.textContent = !id ? '（无场景）' : entry && entry.name !== id ? `${entry.name}（${id}）` : id;
    hint.textContent = fromFallback
      ? `共 ${entries.length} 个（开发服清单接口不可用，退回地图节点清单——梦境/演出/测试场景可能不在其中）`
      : `共 ${entries.length} 个场景（public/assets/scenes 全量）；双击列表项直接跳。`;
  };

  const loadEntries = (): void => {
    void (async () => {
      let next: DebugSceneEntry[] = [];
      let usedFallback = false;
      if (import.meta.env.DEV) {
        try {
          const r = await fetch(SCENE_LIST_API);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          next = normalizeEntries(await r.json());
        } catch {
          next = [];
        }
      }
      if (next.length === 0) {
        usedFallback = true;
        try {
          next = await deps.listFallback();
        } catch (e) {
          deps.log(`场景清单读取失败: ${String(e)}`);
          next = [];
        }
      }
      if (destroyed) return;
      entries = next;
      fromFallback = usedFallback;
      repopulateSelect();
      refreshHeader();
    })();
  };

  const doJump = (): void => {
    const entry = selectedEntry();
    if (!entry) return;
    const sp = spawnSelect.value || undefined;
    deps.log(`场景跳转 → ${entry.id}${sp ? `（spawn: ${sp}）` : ''}`);
    deps.jump(entry.id, sp);
  };

  searchInput.addEventListener('input', () => repopulateSelect());
  select.addEventListener('change', repopulateSpawn);
  select.addEventListener('dblclick', doJump);
  btnGo.addEventListener('click', doJump);
  btnReloadCurrent.addEventListener('click', () => {
    const id = deps.getCurrentSceneId();
    if (!id) {
      deps.log('当前无场景，无法重进');
      return;
    }
    deps.log(`重进当前场景 → ${id}`);
    deps.jump(id);
  });
  btnRefresh.addEventListener('click', loadEntries);

  // 换场景后「当前」行与列表里的 ● 标记要跟上——跳转是 fire-and-forget，
  // 只有等 scene:enter 才知道真进去了（失败退回原场景时同样以事件为准）
  const unsubscribeScene = deps.onSceneChanged(() => {
    refreshHeader();
    repopulateSelect();
  });

  refreshHeader();
  loadEntries();

  return {
    root: sec,
    refresh(): void {
      refreshHeader();
      repopulateSelect();
      loadEntries();
    },
    destroy(): void {
      destroyed = true;
      unsubscribeScene();
      sec.replaceChildren();
    },
  };
}
