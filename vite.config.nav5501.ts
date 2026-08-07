// 临时：键盘导航自验专用隔离取景服（收工删除）
import base from './vite.config';

export default {
  ...base,
  server: { port: 5501, strictPort: true, host: '127.0.0.1', open: false, hmr: false },
};
