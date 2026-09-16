import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('src-tauri/src/windows_ipc.js', 'utf8');
const key = 'main-frame-only-test-key';
const message = () => ({ cmd: 'read_text_file', callback: 1, error: 2, payload: { path: 'C:\\fixture\\note.md' } });
function create(href = 'http://tauri.localhost/', top = true, development = false) {
  const callback = vi.fn();
  const native = vi.fn();
  const fetcher = vi.fn().mockResolvedValue({
    headers: new Headers({ 'Tauri-Response': 'ok', 'content-type': 'application/json' }),
    json: async () => ({ content: 'fixture' }),
  });
  const bridge = { runCallback: callback, convertFileSrc: (command, protocol) => `http://${protocol}.localhost/${command}` };
  const window = { location: { href }, __TAURI_INTERNALS__: bridge, ipc: { postMessage: native } };
  window.top = top ? window : {};
  runInNewContext(source.replace('__LOCALVIEW_DEV__', String(development)).replace('__INVOKE_KEY__', JSON.stringify(key)), {
    window, URL, Headers, fetch: fetcher, ArrayBuffer, Uint8Array, Map,
  });
  return { post: bridge.postMessage, callback, native, fetcher };
}

describe('Windows main-frame-only IPC transport', () => {
  it('preserves native JSON invokes from the packaged app', async () => {
    const test = create();
    test.post(message());
    await vi.waitFor(() => expect(test.callback).toHaveBeenCalledWith(1, { content: 'fixture' }));
    const [url, options] = test.fetcher.mock.calls[0];
    expect(url).toBe('http://ipc.localhost/read_text_file');
    expect(options.headers.get('Tauri-Invoke-Key')).toBe(key);
    expect(JSON.parse(options.body)).toEqual(message().payload);
    expect(test.post.toString()).not.toContain(key);
    expect(test.native).not.toHaveBeenCalled();
  });
  it.each(['http://tauri.localhost/', 'http://localview.localhost/preview/token/page.html', 'about:srcdoc', 'data:text/html,test'])('denies a subframe at %s before any native request', href => {
    const test = create(href, false);
    test.post(message());
    expect(test.callback).toHaveBeenCalledWith(2, 'Command not allowed from document preview');
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.native).not.toHaveBeenCalled();
    expect(test.post.toString()).not.toContain(key);
  });
  it.each(['http://localview.localhost/preview/token/page.html', 'https://example.com/', 'http://tauri.localhost.evil/index.html', 'http://tauri.localhost/not-an-app.html', 'http://localhost:1420/'])('denies an untrusted release navigation at %s', href => {
    const test = create(href);
    test.post(message());
    expect(test.callback).toHaveBeenCalledWith(2, 'Command not allowed from document preview');
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.native).not.toHaveBeenCalled();
  });
  it('allows the fixed development origin only in debug top-level frames', async () => {
    const test = create('http://localhost:1420/', true, true);
    test.post(message());
    await vi.waitFor(() => expect(test.callback).toHaveBeenCalledWith(1, { content: 'fixture' }));
    const child = create('http://localhost:1420/', false, true);
    child.post(message());
    expect(child.fetcher).not.toHaveBeenCalled();
  });
  it('preserves typed arrays, Maps and Tauri serialization hooks', async () => {
    const test = create('http://tauri.localhost/index.html');
    test.post({ ...message(), payload: { bytes: new Uint8Array([1, 2]), map: new Map([['a', 3]]), channel: { __TAURI_TO_IPC_KEY__: () => 'channel:4' } } });
    await vi.waitFor(() => expect(test.callback).toHaveBeenCalled());
    expect(JSON.parse(test.fetcher.mock.calls[0][1].body)).toEqual({ bytes: [1, 2], map: { a: 3 }, channel: 'channel:4' });
  });
  it('retains the native postMessage fallback only for the trusted main frame', async () => {
    const test = create();
    test.fetcher.mockRejectedValue(new Error('Custom protocol unavailable'));
    test.post(message());
    await vi.waitFor(() => expect(test.native).toHaveBeenCalledOnce());
    expect(JSON.parse(test.native.mock.calls[0][0])).toMatchObject({ cmd: 'read_text_file', __TAURI_INVOKE_KEY__: key, payload: message().payload, options: { customProtocolIpcBlocked: true } });
  });
  it('routes native error responses to the rejection callback', async () => {
    const test = create();
    test.fetcher.mockResolvedValue({ headers: new Headers({ 'Tauri-Response': 'error', 'content-type': 'text/plain' }), text: async () => 'CONFLICT' });
    test.post(message());
    await vi.waitFor(() => expect(test.callback).toHaveBeenCalledWith(2, 'CONFLICT'));
  });
});
