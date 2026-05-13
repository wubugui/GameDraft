/**
 * fal.run 模型路径（不含域名），与模型页 ID 一致。
 * @see https://fal.ai/docs/documentation/model-apis/overview
 * @see https://fal.ai/models
 */

/** 默认：Nano Banana 2 编辑（与精灵「参考图 + 提示」流程一致） */
export const DEFAULT_FAL_MODEL_PATH = 'fal-ai/nano-banana-2/edit';

/**
 * 已在 `falProvider` 内适配请求体的编辑/图生图端点。
 * @see https://fal.ai/models/fal-ai/nano-banana-2/edit/api
 * @see https://fal.ai/models/openai/gpt-image-2/edit
 */
export const FAL_I2I_MODEL_PRESETS = Object.freeze([
  'fal-ai/nano-banana-2/edit',
  'openai/gpt-image-2/edit',
  'fal-ai/flux/dev/image-to-image',
]);

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
export function normalizeFalModelPath(raw) {
  let p = (raw ?? '').trim();
  if (!p) {
    return DEFAULT_FAL_MODEL_PATH;
  }
  p = p.replace(/^https?:\/\/fal\.run\//i, '');
  p = p.replace(/^\/+/, '');
  return p || DEFAULT_FAL_MODEL_PATH;
}
