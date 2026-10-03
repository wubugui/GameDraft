import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

type Method = (...args: unknown[]) => unknown;
type WrapMethod = (this: object, name: string, method: Method) => Method;
function inspector() {
  const source = readFileSync('tools/webgpu_capture/vendor/webgpu_inspector.js', 'utf8');
  const start = source.indexOf('class p{');
  const end = source.indexOf('const d=', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Execute the vendored class itself. The context supplies signals without
  // installing its GPU prototype hooks or requiring a GPU in a unit test.
  const wrap = new Function('u', `${source.slice(start, end)}return p.prototype._wrapMethod;`)(() => 'fixture stack') as WrapMethod;
  const context = {
    _skipRecord: 0,
    recordStacktraces: false,
    _idGenerator: { getNextId: vi.fn(() => 41) },
    onPreCall: null as Method | null,
    onPostCall: null as Method | null,
    onPromise: { emit: vi.fn() },
    onPromiseResolve: { emit: vi.fn() },
  };
  return { context, wrap: (name: string, method: Method) => wrap.call(context, name, method) };
}

describe('vendored WebGPU Inspector preserves native async results', () => {
  it('propagates a pending mapAsync cancellation to the caller with the original error', async () => {
    const { context, wrap } = inspector();
    const target = { label: 'readback' };
    const error = new DOMException('Buffer destroyed before mapping resolved', 'AbortError');
    let reject!: (reason: unknown) => void;
    const native = new Promise<void>((_resolve, fail) => { reject = fail; });
    const result = wrap('mapAsync', () => native).call(target, 1) as Promise<void>;
    const rejected = expect(result).rejects.toBe(error);
    reject(error);
    await rejected;
    expect(context.onPromise.emit).toHaveBeenCalledWith(target, 'mapAsync', [1], 41, undefined);
    expect(context.onPromiseResolve.emit).not.toHaveBeenCalled();
  });

  it('returns successful results and records their exact object and call arguments once', async () => {
    const { context, wrap } = inspector();
    context.recordStacktraces = true;
    const target = {};
    const device = { label: 'GPU device' };
    const options = { requiredFeatures: ['timestamp-query'] };
    const method = vi.fn(function (this: unknown, value: unknown) {
      expect(this).toBe(target);
      expect(value).toBe(options);
      return Promise.resolve(device);
    });
    await expect(wrap('requestDevice', method).call(target, options)).resolves.toBe(device);
    expect(method).toHaveBeenCalledTimes(1);
    expect(context.onPromiseResolve.emit).toHaveBeenCalledExactlyOnceWith(
      target, 'requestDevice', [options], 41, device, 'fixture stack');
  });

  it('rejects observer errors rather than leaving a successful GPU operation pending', async () => {
    const { context, wrap } = inspector();
    const error = new Error('observer failed');
    context.onPromiseResolve.emit.mockImplementation(() => { throw error; });
    await expect(wrap('mapAsync', () => Promise.resolve()).call({})).rejects.toBe(error);
  });

  it('preserves the original promise when recording is disabled', async () => {
    const { context, wrap } = inspector();
    context._skipRecord = 1;
    const native = Promise.resolve('mapped');
    const result = wrap('mapAsync', () => native).call({});
    expect(result).toBe(native);
    await expect(result).resolves.toBe('mapped');
    expect(context.onPromise.emit).not.toHaveBeenCalled();
  });

  it('retains synchronous return values, exceptions, and destroy cleanup semantics', () => {
    const { context, wrap } = inspector();
    context.onPostCall = vi.fn();
    const target = {};
    expect(wrap('getMappedRange', () => 123).call(target, 0)).toBe(123);
    expect(context.onPostCall).toHaveBeenCalledWith(target, 'getMappedRange', [0], 123, undefined);
    const error = new Error('native failure');
    const fail = () => { throw error; };
    expect(() => wrap('createBuffer', fail).call(target)).toThrow(error);
    expect(wrap('destroy', fail).call(target)).toBeUndefined();
  });
});
