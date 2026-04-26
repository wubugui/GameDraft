import { editImage as openaiEditImage } from './openaiProvider.js';
import { editImage as falFluxEditImage } from './falProvider.js';
import { editImage as dashscopeWanEditImage } from './dashscopeWanProvider.js';

export const IMAGE_PROVIDER_IDS = /** @type {const} */ (['openai', 'fal_flux', 'dashscope_wan27']);

/** @typedef {{ id: string, label: string, keyLabel: string, keyHint: string }} ImageProviderInfo */

/** @returns {ImageProviderInfo[]} */
export function listImageProviders() {
  return [
    {
      id: 'openai',
      label: 'OpenAI · GPT-Image-1 (edits, transparent)',
      keyLabel: 'OpenAI API Key',
      keyHint: 'sk-… from platform.openai.com — image API access required.',
    },
    {
      id: 'fal_flux',
      label: 'fal.ai · 图像编辑（Nano Banana 2 / GPT Image 2 / FLUX 等）',
      keyLabel: 'fal.ai API Key',
      keyHint:
        'FAL_KEY: fal.ai/dashboard/keys. Sync POST https://fal.run/<model-id> per docs; see Model APIs overview. CORS may require proxy.',
    },
    {
      id: 'dashscope_wan27',
      label: '阿里云百炼 · 万相 wan2.7-image (同步编辑)',
      keyLabel: 'DashScope API Key',
      keyHint:
        '百炼 API Key（Bearer）。北京等国内地域默认 dashscope.aliyuncs.com；国际站可设 localStorage spriteforge_dashscope_region=intl。浏览器直连可能遇 CORS，需代理时同源转发。',
    },
  ];
}

/**
 * @param {string} providerId
 * @param {{ apiKey: string, prompt: string, imageFile: File | Blob, falModelPath?: string, dashscopeModel?: string }} ctx
 * @returns {Promise<string>} data URL
 */
export async function editImageWithProvider(providerId, ctx) {
  switch (providerId) {
    case 'fal_flux':
      return falFluxEditImage(ctx);
    case 'dashscope_wan27':
      return dashscopeWanEditImage(ctx);
    case 'openai':
    default:
      return openaiEditImage(ctx);
  }
}

/** @param {string} id */
export function isValidImageProviderId(id) {
  return IMAGE_PROVIDER_IDS.includes(/** @type {any} */ (id));
}
