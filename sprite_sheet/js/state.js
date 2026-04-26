// Global state management
import { isValidImageProviderId } from './providers/registry.js';
import {
  DEFAULT_DASHSCOPE_IMAGE_MODEL,
  mergeModelListForUi,
  fetchCompatibleModelIds,
} from './providers/dashscopeModelCatalog.js';
import { DEFAULT_FAL_MODEL_PATH, FAL_I2I_MODEL_PRESETS } from './providers/falModelCatalog.js';

let state = {
  providerId: 'openai',
  apiKey: '',
  falModelPath: DEFAULT_FAL_MODEL_PATH,
  dashscopeModelId: DEFAULT_DASHSCOPE_IMAGE_MODEL,
  uploadedImage: null,
  selectedStyle: null,
  selectedAction: null,
  generatedStyles: [],
  generatedFrames: [],
  currentReferenceToken: null,
  selectedModel: 'gpt-image-1',
};

const STORAGE_PROVIDER = 'spriteforge_provider';
const STORAGE_DASHSCOPE_MODEL = 'spriteforge_dashscope_model_id';
const STORAGE_FAL_MODEL_PATH = 'spriteforge_fal_model_path';

function keySlot(providerId) {
  return `spriteforge_key_${providerId}`;
}

function migrateLegacyApiKeys() {
  const legacy = localStorage.getItem('openai_api_key') || localStorage.getItem('apiKey');
  if (legacy && !localStorage.getItem(keySlot('openai'))) {
    localStorage.setItem(keySlot('openai'), legacy);
  }
}

function loadProviderAndKeyFromStorage() {
  migrateLegacyApiKeys();
  let pid = localStorage.getItem(STORAGE_PROVIDER) || 'openai';
  if (!isValidImageProviderId(pid)) {
    pid = 'openai';
  }
  const key = localStorage.getItem(keySlot(pid)) || '';
  state.providerId = pid;
  state.apiKey = key;
  state.dashscopeModelId =
    localStorage.getItem(STORAGE_DASHSCOPE_MODEL)?.trim() || DEFAULT_DASHSCOPE_IMAGE_MODEL;
  state.falModelPath =
    localStorage.getItem(STORAGE_FAL_MODEL_PATH)?.trim() || DEFAULT_FAL_MODEL_PATH;
}

function persistProviderKey(providerId, apiKey) {
  localStorage.setItem(keySlot(providerId), apiKey);
  if (providerId === 'openai') {
    localStorage.setItem('openai_api_key', apiKey);
    localStorage.setItem('apiKey', apiKey);
  }
}

function updateProviderLabels() {
  const labelEl = document.getElementById('apiKeyLabel');
  const hintEl = document.getElementById('apiKeyHint');
  if (!labelEl || !hintEl) return;

  const meta = {
    openai: {
      label: 'OpenAI API Key',
      hint: 'For GPT-Image-1 image edits (transparent background). Requires image-capable key.',
    },
    fal_flux: {
      label: 'fal.ai API Key',
      hint: 'From fal.ai dashboard. If the browser blocks fal.run (CORS), route via proxy or server.',
    },
    dashscope_wan27: {
      label: 'DashScope API Key',
      hint:
        '阿里云百炼 / Model Studio API Key。万相 wan2.7-image 同步接口；国内默认 endpoint。若 CORS 拦截请在本地或网关做同源代理。',
    },
  }[state.providerId];

  if (meta) {
    labelEl.textContent = meta.label;
    hintEl.textContent = meta.hint;
  }
}

export function getState() {
  return state;
}

export function updateState(newState) {
  let merged = { ...state, ...newState };

  if (newState.dashscopeModelId !== undefined) {
    const m = String(newState.dashscopeModelId).trim() || DEFAULT_DASHSCOPE_IMAGE_MODEL;
    merged = { ...merged, dashscopeModelId: m };
    localStorage.setItem(STORAGE_DASHSCOPE_MODEL, m);
  }

  if (newState.falModelPath !== undefined) {
    const fp = String(newState.falModelPath).trim() || DEFAULT_FAL_MODEL_PATH;
    merged = { ...merged, falModelPath: fp };
    localStorage.setItem(STORAGE_FAL_MODEL_PATH, fp);
  }

  if (newState.providerId !== undefined) {
    if (isValidImageProviderId(newState.providerId)) {
      localStorage.setItem(STORAGE_PROVIDER, newState.providerId);
    }
  }

  if (newState.apiKey !== undefined) {
    persistProviderKey(merged.providerId, newState.apiKey);
  }

  state = merged;
  updateUIState();
}

export function updateUIState() {
  const apiKeyInput = document.getElementById('apiKey');
  if (apiKeyInput && state.apiKey !== undefined) {
    apiKeyInput.value = state.apiKey;
  }
  const providerSelect = document.getElementById('imageProvider');
  if (providerSelect && state.providerId) {
    providerSelect.value = state.providerId;
  }

  const falRow = document.getElementById('falModelRow');
  if (falRow) {
    falRow.classList.toggle('hidden', state.providerId !== 'fal_flux');
  }
  const falPathInput = document.getElementById('falModelPath');
  if (falPathInput && state.falModelPath) {
    falPathInput.value = state.falModelPath;
  }
  if (state.providerId === 'fal_flux') {
    const falDl = document.getElementById('falModelList');
    if (falDl && !falDl.querySelector('option')) {
      fillFalDatalist();
    }
  }

  const dashRow = document.getElementById('dashscopeModelRow');
  if (dashRow) {
    dashRow.classList.toggle('hidden', state.providerId !== 'dashscope_wan27');
  }
  const modelInput = document.getElementById('dashscopeModelId');
  if (modelInput && state.dashscopeModelId) {
    modelInput.value = state.dashscopeModelId;
  }
  if (state.providerId === 'dashscope_wan27') {
    const dl = document.getElementById('dashscopeModelList');
    if (dl && !dl.querySelector('option')) {
      fillDashscopeDatalist(mergeModelListForUi([]));
    }
  }

  updateProviderLabels();
}

function fillDashscopeDatalist(modelIds) {
  const dl = document.getElementById('dashscopeModelList');
  if (!dl) return;
  dl.innerHTML = '';
  for (const id of modelIds) {
    const opt = document.createElement('option');
    opt.value = id;
    dl.appendChild(opt);
  }
}

function fillFalDatalist() {
  const dl = document.getElementById('falModelList');
  if (!dl) return;
  dl.innerHTML = '';
  for (const id of FAL_I2I_MODEL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = id;
    dl.appendChild(opt);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadProviderAndKeyFromStorage();

  const providerSelect = document.getElementById('imageProvider');
  const apiKeyInput = document.getElementById('apiKey');

  if (providerSelect) {
    providerSelect.value = state.providerId;
    providerSelect.addEventListener('change', () => {
      const prevId = state.providerId;
      const currentVal = (apiKeyInput?.value ?? '').trim();
      if (prevId) {
        persistProviderKey(prevId, currentVal);
      }
      const newId = providerSelect.value;
      if (!isValidImageProviderId(newId)) {
        return;
      }
      state.providerId = newId;
      localStorage.setItem(STORAGE_PROVIDER, newId);
      const nextKey = localStorage.getItem(keySlot(newId)) || '';
      state.apiKey = nextKey;
      if (apiKeyInput) {
        apiKeyInput.value = nextKey;
      }
      updateUIState();
    });
  }

  if (apiKeyInput) {
    if (state.apiKey) {
      apiKeyInput.value = state.apiKey;
    }
    apiKeyInput.addEventListener('input', () => {
      const v = apiKeyInput.value;
      state.apiKey = v;
      persistProviderKey(state.providerId, v);
    });
  }

  const falPathEl = document.getElementById('falModelPath');
  if (falPathEl) {
    falPathEl.addEventListener('input', () => {
      const v = falPathEl.value.trim() || DEFAULT_FAL_MODEL_PATH;
      state = { ...state, falModelPath: v };
      localStorage.setItem(STORAGE_FAL_MODEL_PATH, v);
    });
  }

  const dashModelInput = document.getElementById('dashscopeModelId');
  if (dashModelInput) {
    dashModelInput.addEventListener('input', () => {
      const v = dashModelInput.value.trim() || DEFAULT_DASHSCOPE_IMAGE_MODEL;
      state = { ...state, dashscopeModelId: v };
      localStorage.setItem(STORAGE_DASHSCOPE_MODEL, v);
    });
  }

  const dashRefresh = document.getElementById('dashscopeModelRefresh');
  if (dashRefresh) {
    dashRefresh.addEventListener('click', async () => {
      const statusEl = document.getElementById('dashscopeModelStatus');
      const key = state.apiKey?.trim();
      if (!key) {
        if (statusEl) statusEl.textContent = '请先填写 DashScope API Key';
        return;
      }
      if (statusEl) statusEl.textContent = '正在拉取模型列表…';
      dashRefresh.disabled = true;
      try {
        const { allIds, filteredIds } = await fetchCompatibleModelIds(key);
        const merged = mergeModelListForUi(filteredIds);
        fillDashscopeDatalist(merged);
        let msg = `接口共 ${allIds.length} 个模型，筛选出 ${filteredIds.length} 个可能为万相/图像类 id。`;
        if (filteredIds.length === 0) {
          msg += ' 可直接在输入框填写控制台中的模型名。';
        }
        if (statusEl) statusEl.textContent = msg;
      } catch (e) {
        fillDashscopeDatalist(mergeModelListForUi([]));
        if (statusEl) {
          statusEl.textContent = `拉取失败：${e instanceof Error ? e.message : String(e)}（已保留内置候选项）`;
        }
      } finally {
        dashRefresh.disabled = false;
      }
    });
  }

  updateUIState();
});

export const storage = {
  getApiKey: () => localStorage.getItem('openai_api_key'),
  setApiKey: (key) => {
    const k = key.trim();
    localStorage.setItem('openai_api_key', k);
    localStorage.setItem(keySlot('openai'), k);
  },
};

export function updateSourceImage(file) {
  state.sourceImageFile = file;
}

export function updateChosenStyle(style) {
  state.chosenStyle = style;
}

export function resetStyleChoice() {
  state.chosenStyle = null;
}
