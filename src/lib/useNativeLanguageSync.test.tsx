import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguagePreference, LANGUAGE_STORAGE_KEY, setLanguagePreference } from './i18n';
import { useNativeLanguageSync } from './useNativeLanguageSync';

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), stop: vi.fn(),
  event: undefined as undefined | ((event: { payload: unknown }) => void),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
function TestWindow() { useNativeLanguageSync(); return null; }

beforeEach(() => {
  vi.clearAllMocks(); bridge.event = undefined;
  bridge.listen.mockImplementation(async (_: string, callback: typeof bridge.event) => {
    bridge.event = callback; return bridge.stop;
  });
  bridge.invoke.mockImplementation(async (_: string, { request }: { request: { action: string; preference?: string } }) =>
    ({ preference: request.preference ?? 'en', revision: 0 }));
});

describe('native language authority', () => {
  it('serializes rapid selections and rejects stale native and storage echoes', async () => {
    let revision = 0;
    const writes: string[] = [];
    bridge.invoke.mockImplementation(async (_: string, { request }: { request: { action: string; preference: string } }) => {
      if (request.action === 'initialize') return { preference: 'en', revision: 0 };
      if (request.action === 'menu') return null;
      writes.push(request.preference);
      const snapshot = { preference: request.preference, revision: ++revision };
      bridge.event?.({ payload: snapshot }); // includes the initiating window, as Tauri does
      return snapshot;
    });
    render(<TestWindow />);
    await waitFor(() => expect(getLanguagePreference()).toBe('en'));
    await act(async () => {
      setLanguagePreference('zh-CN'); setLanguagePreference('en'); setLanguagePreference('zh-CN');
    });
    await waitFor(() => expect(writes).toEqual(['zh-CN', 'en', 'zh-CN']));
    await waitFor(() => expect(getLanguagePreference()).toBe('zh-CN'));
    act(() => {
      bridge.event?.({ payload: { preference: 'en', revision: 2 } });
      window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(getLanguagePreference()).toBe('zh-CN');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN');
  });

  it('hydrates a new window from the process snapshot and accepts only newer valid events', async () => {
    bridge.invoke.mockResolvedValue({ preference: 'en', revision: 7 });
    render(<TestWindow />);
    await waitFor(() => expect(getLanguagePreference()).toBe('en'));
    act(() => bridge.event?.({ payload: { preference: 'zh-CN', revision: 8 } }));
    expect(getLanguagePreference()).toBe('zh-CN');
    act(() => {
      bridge.event?.({ payload: { preference: 'en', revision: 7 } });
      bridge.event?.({ payload: { preference: 'unknown', revision: 9 } });
      bridge.event?.({ payload: 'en' });
    });
    expect(getLanguagePreference()).toBe('zh-CN');
    const selections = bridge.invoke.mock.calls.filter(([, arg]) => arg.request.action === 'select');
    expect(selections).toHaveLength(0);
  });

  it('removes listeners and never applies late acknowledgments after unmount', async () => {
    let resolve!: (value: unknown) => void;
    bridge.invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { unmount } = render(<TestWindow />);
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
    unmount();
    await act(async () => resolve({ preference: 'en', revision: 1 }));
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(getLanguagePreference()).toBe('zh-CN');
  });
});
