/**
 * URL / 路径工具(移植自 PixiJS v8.17(MIT):`utils/path`,只取资源系统用到的部分,算法逐行对应)。
 * 相对地址按 `DOMAdapter.get().getBaseUrl()` 解析成绝对地址;data: / blob: 地址原样返回。
 */
import { DOMAdapter } from '../../environment/adapter';

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`);
  }
}

function removeUrlParams(url: string): string {
  const re = url.split('?')[0];
  return re.split('#')[0];
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(str: string, find: string, replace: string): string {
  return str.replace(new RegExp(escapeRegExp(find), 'g'), replace);
}

// 照 Node 的 path.posix.normalize 内部实现
function normalizeStringPosix(path: string, allowAboveRoot: boolean): string {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = -1;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (code === 47) {
      break;
    } else {
      code = 47;
    }
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (lastSlash !== i - 1 && dots === 2) {
        if (
          res.length < 2
          || lastSegmentLength !== 2
          || res.charCodeAt(res.length - 1) !== 46
          || res.charCodeAt(res.length - 2) !== 46
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
              }
              lastSlash = i;
              dots = 0;
              continue;
            }
          } else if (res.length === 2 || res.length === 1) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          if (res.length > 0) {
            res += '/..';
          } else {
            res = '..';
          }
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `/${path.slice(lastSlash + 1, i)}`;
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

export const path = {
  toPosix(path: string): string {
    return replaceAll(path, '\\', '/');
  },
  isUrl(path: string): boolean {
    return /^https?:/.test(this.toPosix(path));
  },
  isDataUrl(path: string): boolean {
    // eslint-disable-next-line max-len
    return /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z0-9-.!#$%*+.{}|~`]+=[a-z0-9-.!#$%*+.{}()_|~`]+)*)?(;base64)?,([a-z0-9!$&',()*+;=\-._~:@\/?%\s<>]*?)$/i
      .test(path);
  },
  isBlobUrl(path: string): boolean {
    return path.startsWith('blob:');
  },
  hasProtocol(path: string): boolean {
    return /^[^/:]+:/.test(this.toPosix(path));
  },
  getProtocol(path: string): string {
    assertPath(path);
    path = this.toPosix(path);
    const matchFile = /^file:\/\/\//.exec(path);
    if (matchFile) return matchFile[0];
    const matchProtocol = /^[^/:]+:\/{0,2}/.exec(path);
    if (matchProtocol) return matchProtocol[0];
    return '';
  },
  /**
   * 转绝对地址:`/` 开头相对根(rootUrl,缺省 = baseUrl 的根),其余相对 baseUrl(缺省 = 适配器的基址);
   * 已带协议的原样返回。
   */
  toAbsolute(url: string, customBaseUrl?: string | null, customRootUrl?: string | null): string {
    assertPath(url);
    if (this.isDataUrl(url) || this.isBlobUrl(url)) return url;
    const baseUrl = removeUrlParams(this.toPosix(customBaseUrl ?? DOMAdapter.get().getBaseUrl()));
    const rootUrl = removeUrlParams(this.toPosix(customRootUrl ?? this.rootname(baseUrl)));
    url = this.toPosix(url);
    if (url.startsWith('/')) {
      return path.join(rootUrl, url.slice(1));
    }
    const absolutePath = this.isAbsolute(url) ? url : this.join(baseUrl, url);
    return absolutePath;
  },
  normalize(path: string): string {
    assertPath(path);
    if (path.length === 0) return '.';
    if (this.isDataUrl(path) || this.isBlobUrl(path)) return path;
    path = this.toPosix(path);
    let protocol = '';
    const isAbsolute = path.startsWith('/');
    if (this.hasProtocol(path)) {
      protocol = this.rootname(path);
      path = path.slice(protocol.length);
    }
    const trailingSeparator = path.endsWith('/');
    path = normalizeStringPosix(path, false);
    if (path.length > 0 && trailingSeparator) path += '/';
    if (isAbsolute) return `/${path}`;
    return protocol + path;
  },
  isAbsolute(path: string): boolean {
    assertPath(path);
    path = this.toPosix(path);
    if (this.hasProtocol(path)) return true;
    return path.startsWith('/');
  },
  join(...segments: string[]): string {
    if (segments.length === 0) return '.';
    let joined: string | undefined;
    for (let i = 0; i < segments.length; ++i) {
      const arg = segments[i];
      assertPath(arg);
      if (arg.length > 0) {
        if (joined === undefined) joined = arg;
        else {
          const prevArg = segments[i - 1] ?? '';
          if (this.joinExtensions.includes(this.extname(prevArg).toLowerCase())) {
            joined += `/../${arg}`;
          } else {
            joined += `/${arg}`;
          }
        }
      }
    }
    if (joined === undefined) return '.';
    return this.normalize(joined);
  },
  dirname(path: string): string {
    assertPath(path);
    if (path.length === 0) return '.';
    path = this.toPosix(path);
    let code = path.charCodeAt(0);
    const hasRoot = code === 47;
    let end = -1;
    let matchedSlash = true;
    const proto = this.getProtocol(path);
    const origpath = path;
    path = path.slice(proto.length);
    for (let i = path.length - 1; i >= 1; --i) {
      code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) return hasRoot ? '/' : this.isUrl(origpath) ? proto + path : proto;
    if (hasRoot && end === 1) return '//';
    return proto + path.slice(0, end);
  },
  rootname(path: string): string {
    assertPath(path);
    path = this.toPosix(path);
    let root = '';
    if (path.startsWith('/')) root = '/';
    else root = this.getProtocol(path);
    if (this.isUrl(path)) {
      const index = path.indexOf('/', root.length);
      if (index !== -1) root = path.slice(0, index);
      else root = path;
      if (!root.endsWith('/')) root += '/';
    }
    return root;
  },
  extname(path: string): string {
    assertPath(path);
    path = removeUrlParams(this.toPosix(path));
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === 46) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    if (
      startDot === -1
      || end === -1
      || preDotState === 0
      || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return '';
    }
    return path.slice(startDot, end);
  },
  sep: '/',
  delimiter: ':',
  joinExtensions: ['.html'],
};
