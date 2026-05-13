/**
 * 阿里云百炼 DashScope — 万相 2.7 图像编辑（同步）
 * POST .../aigc/multimodal-generation/generation
 * @see https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference
 */

import { DEFAULT_DASHSCOPE_IMAGE_MODEL } from './dashscopeModelCatalog.js';

const ENDPOINT_CN = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ENDPOINT_INTL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** 百炼万相侧校验：输入图宽高均须 ≥ 此值（否则会报 128×128 不满足等错误） */
const DASHSCOPE_MIN_INPUT_EDGE = 240;

function resolveEndpoint() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('spriteforge_dashscope_region') === 'intl') {
      return ENDPOINT_INTL;
    }
  } catch {
    /* ignore */
  }
  return ENDPOINT_CN;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * @param {string} dataUrl
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image for DashScope min size'));
    img.src = dataUrl;
  });
}

/**
 * 将输入图放大到至少 DASHSCOPE_MIN_INPUT_EDGE（等比，保留透明底）。
 * 本工具上游常把预览做成 128×128，连续帧会沿用上一帧，故在此统一兜底。
 * @param {File | Blob} imageFile
 * @returns {Promise<string>} data URL (PNG)
 */
async function imageFileToDashScopeDataUrl(imageFile) {
  const rawDataUrl = await readFileAsDataURL(imageFile);
  const img = await loadImageFromDataUrl(rawDataUrl);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (sw < 1 || sh < 1) {
    throw new Error('Invalid image dimensions');
  }
  if (sw >= DASHSCOPE_MIN_INPUT_EDGE && sh >= DASHSCOPE_MIN_INPUT_EDGE) {
    return rawDataUrl;
  }
  const scale = DASHSCOPE_MIN_INPUT_EDGE / Math.min(sw, sh);
  const dw = Math.max(DASHSCOPE_MIN_INPUT_EDGE, Math.round(sw * scale));
  const dh = Math.max(DASHSCOPE_MIN_INPUT_EDGE, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D not available');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(img, 0, 0, dw, dh);
  return canvas.toDataURL('image/png');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {unknown} json
 * @returns {string | null}
 */
function extractOutputImageUrl(json) {
  const choices = json?.output?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = choices[0]?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part.image === 'string') {
      return part.image;
    }
  }
  return null;
}

export async function editImage({ apiKey, prompt, imageFile, dashscopeModel }) {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('Missing API key');
  }
  if (!(imageFile instanceof File || imageFile instanceof Blob)) {
    throw new Error('Invalid image type: expected File or Blob');
  }

  const modelId =
    typeof dashscopeModel === 'string' && dashscopeModel.trim()
      ? dashscopeModel.trim()
      : DEFAULT_DASHSCOPE_IMAGE_MODEL;

  const imageDataUrl = await imageFileToDashScopeDataUrl(imageFile);
  const endpoint = resolveEndpoint();

  const body = {
    model: modelId,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ image: imageDataUrl }, { text: prompt }],
        },
      ],
    },
    parameters: {
      size: '2K',
      n: 1,
      watermark: false,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`DashScope: non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const msg = json.message || json.msg || json.error?.message || `HTTP ${response.status}`;
    const code = json.code ? `${json.code}: ` : '';
    throw new Error(`${code}${msg}`);
  }

  const imageRef = extractOutputImageUrl(json);
  if (!imageRef) {
    throw new Error('DashScope: no image in response');
  }

  if (imageRef.startsWith('data:')) {
    return imageRef;
  }

  const imgRes = await fetch(imageRef);
  if (!imgRes.ok) {
    throw new Error('DashScope: failed to download output image');
  }
  const blob = await imgRes.blob();
  return blobToDataURL(blob);
}
