/**
 * 解析资产路径为相对 URL（如 ./assets/...），支持 Vite base 部署。
 * 输出始终为相对路径，由浏览器解析。若看到 C:/ 等盘符，多因通过 file:// 直接打开 HTML，
 * 建议用 `npm run dev` 或 `npx serve dist` 通过 HTTP 访问。
 */
export function resolveAssetPath(path: string): string {
  if (!path || typeof path !== 'string') return path;
  const meta = typeof import.meta !== 'undefined' ? import.meta : undefined;
  const baseUrl = (meta as { env?: { BASE_URL?: string } })?.env?.BASE_URL;
  const base = baseUrl != null ? String(baseUrl) : '/';
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  const baseNorm = base.endsWith('/') ? base.slice(0, -1) : base;
  if (baseNorm === '.' || baseNorm === '') {
    return normalized ? `./${normalized}` : '.';
  }
  return baseNorm + '/' + normalized;
}

/** 使用解析后的路径 fetch 资产 */
export async function fetchAsset(path: string): Promise<Response> {
  return fetch(resolveAssetPath(path));
}

/**
 * 将 anim.json 同目录下的相对资源路径解析为以 / 开头的资产路径（供 loadTexture/loadJson 使用）。
 * - `spritesheet` 为 `/assets/...` 时原样返回；
 * - 否则视为相对 anim清单文件所在目录。
 */
export function resolvePathRelativeToAnimManifest(animManifestPath: string, ref: string): string {
  const r = (ref || '').trim();
  if (!r) return r;
  if (r.startsWith('http://') || r.startsWith('https://')) return r;
  if (r.startsWith('/assets/')) return r;
  const base = animManifestPath.replace(/\/[^/]+$/, '');
  const part = r.startsWith('./') ? r.slice(2) : r;
  const joined = `${base}/${part}`.replace(/\/+/g, '/');
  if (!joined.startsWith('/')) {
    return `/${joined}`;
  }
  return joined;
}
