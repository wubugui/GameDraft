import { reportDevError } from './devErrorOverlay';

export function depthLog(tag: string, ...args: unknown[]): void {
    const msg = `[${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
    console.log(msg);
}

export function depthError(tag: string, ...args: unknown[]): void {
    const msg = `[${tag}] ERROR: ${args.map(a => {
        if (a instanceof Error) return a.message + '\\n' + a.stack;
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ')}`;
    console.error(msg);
    reportDevError(msg);
}
