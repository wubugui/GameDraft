import { reportDevError } from './devErrorOverlay';

export function depthLog(tag: string, ...args: unknown[]): void {
    // 生产构建早退：必须在拼接字符串之前（JSON.stringify 逐帧调用是纯开销）
    if (!import.meta.env.DEV) return;
    const msg = `[${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
    console.log(msg);
}

export function depthError(tag: string, ...args: unknown[]): void {
    const msg = `[${tag}] ERROR: ${args.map(a => {
        if (a instanceof Error) return a.message + '\n' + a.stack;
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ')}`;
    console.error(msg);
    reportDevError(msg);
}
