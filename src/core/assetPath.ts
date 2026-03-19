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
