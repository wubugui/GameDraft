import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// 渲染像素对照页:直接用 src/ 下的运行时代码,不经游戏入口。
// 端口避开编辑器(5173)、agent(5174–5188)、RHI 冒烟(5191)、扫描(5194–5197)、验收门(5199/5299);被占就往后找。
// 依赖预构建缓存按工作树分开放(多个 git worktree 共用一份 node_modules 时互不踩)。
export default defineConfig({
  root: here,
  cacheDir: path.join(os.tmpdir(), 'render-parity-vite', createHash('sha1').update(here).digest('hex').slice(0, 12)),
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5192,
    strictPort: false,
    // node_modules 可能是指向别处的软链(worktree),放开同源文件访问限制;这是本地测试页
    fs: { strict: false, allow: [repoRoot] },
  },
});
