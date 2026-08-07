// 临时：物件检视 UI 外壳自验专用隔离取景服（收工删除）
import base from './vite.config';

export default {
  ...base,
  server: { port: 5604, strictPort: true, host: '127.0.0.1', open: false, hmr: false },
};
