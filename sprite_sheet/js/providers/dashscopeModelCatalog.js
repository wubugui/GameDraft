/**
 * 通过 DashScope OpenAI 兼容接口枚举模型，并筛选万相/图像编辑类 model id。
 * GET {base}/compatible-mode/v1/models
 */

export const FALLBACK_DASHSCOPE_IMAGE_MODELS = Object.freeze([
  'wan2.7-image',
  'wan2.7-image-pro',
]);

export const DEFAULT_DASHSCOPE_IMAGE_MODEL = 'wan2.7-image';

/** @returns {'https://dashscope.aliyuncs.com' | 'https://dashscope-intl.aliyuncs.com'} */
export function getDashscopeCompatibleBase() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('spriteforge_dashscope_region') === 'intl') {
      return 'https://dashscope-intl.aliyuncs.com';
    }
  } catch {
    /* ignore */
  }
  return 'https://dashscope.aliyuncs.com';
}

/**
 * 从兼容接口返回的 id 中挑出更可能用于「万相 / 图像生成编辑」的项（启发式）。
 * @param {string[]} ids
 * @returns {string[]}
 */
export function filterWanStyleImageModels(ids) {
  const out = new Set();
  for (const raw of ids) {
    if (!raw || typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id) continue;
    const lower = id.toLowerCase();
    if (lower.includes('wan2.') && lower.includes('image')) {
      out.add(id);
      continue;
    }
    if (/^wan[xv]?[0-9]*[._-]*.*image/i.test(id)) {
      out.add(id);
      continue;
    }
    if (lower.includes('wanx') && lower.includes('image')) {
      out.add(id);
    }
  }
  return [...out];
}

/**
 * @param {string[]} remoteFiltered
 * @returns {string[]}
 */
export function mergeModelListForUi(remoteFiltered) {
  return [...new Set([...FALLBACK_DASHSCOPE_IMAGE_MODELS, ...remoteFiltered])].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * @param {string} apiKey
 * @returns {Promise<{ allIds: string[], filteredIds: string[] }>}
 */
export async function fetchCompatibleModelIds(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('需要 API Key 才能拉取模型列表');
  }
  const base = getDashscopeCompatibleBase();
  const url = `${base}/compatible-mode/v1/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`模型列表返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const msg = json.message || json.error?.message || text.slice(0, 240);
    throw new Error(`${json.code ? `${json.code}: ` : ''}${msg}`);
  }
  const data = json.data;
  const allIds = Array.isArray(data) ? data.map((x) => x?.id).filter(Boolean) : [];
  return {
    allIds,
    filteredIds: filterWanStyleImageModels(allIds),
  };
}
