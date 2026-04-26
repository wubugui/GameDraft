/**
 * fal.ai Model API — 同步直连 `fal.run`（无队列）
 *
 * 文档要点（与 @fal-ai/client 的 `input: { ... }` 不同，原始终端使用扁平 JSON）：
 * - 概览：https://fal.ai/docs/documentation/model-apis/overview
 * - 同步 run：https://fal.ai/docs/documentation/model-apis/inference/synchronous
 * - 鉴权 + curl 示例：`POST https://fal.run/<model-id>`，`Authorization: Key <FAL_KEY>`，body 为模型 schema 顶层字段
 *   https://fal.ai/docs/documentation/model-apis/authentication
 * - 队列 / 生产：`https://queue.fal.run/...`（本文件未实现轮询，需可自行扩展）
 *
 * 已适配：
 * - Nano Banana 2 Edit：https://fal.ai/models/fal-ai/nano-banana-2/edit/api
 * - GPT Image 2 Edit：https://fal.ai/models/openai/gpt-image-2/edit
 * - FLUX.1 dev i2i：https://fal.ai/models/fal-ai/flux/dev/image-to-image/api
 */

import { normalizeFalModelPath } from './falModelCatalog.js';

/** @param {string} path normalized model path */
function inferFalBodyKind(path) {
  const p = path.toLowerCase();
  if (p.includes('nano-banana-2/edit')) return 'nano_banana_edit';
  if (p.includes('gpt-image-2/edit')) return 'gpt_image_edit';
  return 'flux_dev_i2i';
}

/**
 * @param {'nano_banana_edit' | 'gpt_image_edit' | 'flux_dev_i2i'} kind
 * @param {string} prompt
 * @param {string} imageDataUrl
 */
function buildFalRequestBody(kind, prompt, imageDataUrl) {
  if (kind === 'nano_banana_edit') {
    return {
      prompt,
      image_urls: [imageDataUrl],
      num_images: 1,
      aspect_ratio: 'auto',
      output_format: 'png',
      resolution: '1K',
      limit_generations: true,
      sync_mode: true,
    };
  }
  if (kind === 'gpt_image_edit') {
    return {
      prompt,
      image_urls: [imageDataUrl],
      quality: 'high',
      output_format: 'png',
      image_size: 'auto',
      num_images: 1,
      sync_mode: true,
    };
  }
  return {
    image_url: imageDataUrl,
    prompt,
    strength: 0.92,
    num_inference_steps: 28,
    guidance_scale: 3.5,
    num_images: 1,
    output_format: 'png',
    sync_mode: true,
    enable_safety_checker: true,
  };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
 * 兼容原始终端与 JS SDK 风格响应（部分封装可能返回 data.images）
 * @param {unknown} result
 * @returns {unknown[] | null}
 */
function extractFalImagesArray(result) {
  if (!result || typeof result !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (result);
  if (Array.isArray(o.images)) return o.images;
  const data = o.data;
  if (data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).images)) {
    return /** @type {any} */ (data).images;
  }
  const output = o.output;
  if (output && typeof output === 'object' && Array.isArray(/** @type {any} */ (output).images)) {
    return /** @type {any} */ (output).images;
  }
  return null;
}

export async function editImage({ apiKey, prompt, imageFile, falModelPath }) {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('Missing API key');
  }
  if (!(imageFile instanceof File || imageFile instanceof Blob)) {
    throw new Error('Invalid image type: expected File or Blob');
  }

  const path = normalizeFalModelPath(falModelPath);
  const endpoint = `https://fal.run/${path}`;

  const imageDataUrl = await readFileAsDataURL(imageFile);
  const bodyKind = inferFalBodyKind(path);
  const body = buildFalRequestBody(bodyKind, prompt, imageDataUrl);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      message =
        err.detail?.[0]?.msg ||
        err.message ||
        err.error ||
        (typeof err.detail === 'string' ? err.detail : JSON.stringify(err));
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const result = await response.json();
  const images = extractFalImagesArray(result);
  const first = images?.[0];
  if (!first) {
    throw new Error('fal.ai: no image in response (expected images[] or data.images[])');
  }
  if (typeof first.url === 'string' && first.url.startsWith('data:')) {
    return first.url;
  }
  if (typeof first.url === 'string' && first.url.length > 0) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) {
      throw new Error('Failed to download generated image from fal.ai');
    }
    const blob = await imgRes.blob();
    return blobToDataURL(blob);
  }
  throw new Error('fal.ai: could not parse image output');
}
