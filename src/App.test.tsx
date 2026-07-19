import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const mocks = vi.hoisted(() => ({
  desktop: false,
  closeHandler: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
  openPathHandler: undefined as ((path: string) => void) | undefined,
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  chooseFolder: vi.fn(),
  closeWindow: vi.fn(),
}));

vi.mock('@uiw/react-codemirror', async () => {
  const React = await import('react');
  return {
    default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => {
      const [document, setDocument] = React.useState(value);
      return <textarea
        aria-label="editor"
        value={document}
        onChange={(event) => {
          setDocument(event.target.value);
          onChange?.(event.target.value);
        }}
      />;
    },
  };
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: mocks.closeWindow,
    onCloseRequested: vi.fn(async (handler: typeof mocks.closeHandler) => {
      mocks.closeHandler = handler;
      return () => undefined;
    }),
  }),
}));

vi.mock('./lib/desktop', async () => {
  const actual = await vi.importActual<typeof import('./lib/desktop')>('./lib/desktop');
  return {
    ...actual,
    isTauriRuntime: () => mocks.desktop,
    chooseFolder: mocks.chooseFolder,
    setWorkspaceRoot: vi.fn(async (path: string) => path),
    listDirectory: vi.fn(async (path: string) => {
      if (path === '/workspace') return [{ name: 'docs', path: '/workspace/docs', kind: 'folder' }];
      if (path === '/workspace/docs') return [{ name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' }];
      return [];
    }),
    inspectPath: vi.fn(async (path: string) => ({ name: path.split('/').pop() ?? path, path, kind: 'md' })),
    findWorkspaceRoot: vi.fn(async () => '/workspace'),
    getStartupPath: vi.fn(async () => '/workspace/docs/plan.md'),
    listenForOpenPath: vi.fn(async (handler: (path: string) => void) => {
      mocks.openPathHandler = handler;
      return () => undefined;
    }),
    readTextFile: mocks.readTextFile,
    writeTextFile: mocks.writeTextFile,
    revealPath: vi.fn(async () => undefined),
  };
});

async function editCurrentDocument(value: string) {
  const editor = await screen.findByRole('textbox', { name: 'editor' });
  fireEvent.change(editor, { target: { value } });
  return editor;
}

beforeEach(() => {
  mocks.desktop = false;
  mocks.closeHandler = undefined;
  mocks.openPathHandler = undefined;
  mocks.readTextFile.mockReset();
  mocks.writeTextFile.mockReset();
  mocks.writeTextFile.mockResolvedValue('saved-version');
  mocks.chooseFolder.mockReset();
  mocks.chooseFolder.mockResolvedValue(null);
  mocks.closeWindow.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unsaved transition protection', () => {
  it('keeps the current document until the user explicitly discards edits', async () => {
    const user = userEvent.setup();
    render(<App />);

    await editCurrentDocument('# unsaved draft');
    const targetFile = screen.getByRole('button', { name: /product-notes\.md$/ });
    await user.click(targetFile);

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('project / README.md')).toBeTruthy();
    const cancelButton = screen.getByRole('button', { name: '继续编辑' });
    const confirmButton = screen.getByRole('button', { name: '放弃修改并继续' });
    expect(document.activeElement).toBe(cancelButton);

    await user.tab();
    expect(document.activeElement).toBe(confirmButton);
    await user.tab();
    expect(document.activeElement).toBe(cancelButton);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirmButton);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(targetFile);
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# unsaved draft');

    await user.click(screen.getByRole('button', { name: /product-notes\.md$/ }));
    await user.click(screen.getByRole('button', { name: '放弃修改并继续' }));

    await waitFor(() => expect(screen.getByText('project / product-notes.md')).toBeTruthy());
  });

  it('guards workspace changes, incoming files, and window close requests', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# initial disk', version: 'v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    mocks.closeWindow.mockRejectedValueOnce(new Error('native close failed'));
    const user = userEvent.setup();
    render(<App />);

    await editCurrentDocument('# local draft');

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();

    await act(async () => mocks.openPathHandler?.('/workspace/docs/second.md'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(mocks.closeWindow).not.toHaveBeenCalled();

    await act(async () => mocks.closeHandler?.({ preventDefault }));
    await user.click(screen.getByRole('button', { name: '放弃修改并关闭' }));
    expect(mocks.closeWindow).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText('关闭失败：native close failed')).toBeTruthy());

    const retryPreventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault: retryPreventDefault }));
    expect(retryPreventDefault).toHaveBeenCalledOnce();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
  });
});

describe('external disk changes', () => {
  it('replaces both preview state and the mounted editor for a clean document', async () => {
    mocks.desktop = true;
    mocks.readTextFile
      .mockResolvedValueOnce({ content: '# old disk', version: 'v1' })
      .mockResolvedValue({ content: '# new disk', version: 'v2' });

    let poll: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      poll = handler as () => void;
      return 1;
    }) as typeof window.setInterval);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# old disk'));
    expect(poll).toBeTypeOf('function');

    await act(async () => {
      poll?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# new disk'));
    expect(screen.getByRole('heading', { name: 'new disk' })).toBeTruthy();
  });

  it('keeps local edits on conflict until the user chooses a resolution', async () => {
    mocks.desktop = true;
    mocks.readTextFile
      .mockResolvedValueOnce({ content: '# disk v1', version: 'v1' })
      .mockResolvedValue({ content: '# disk v2', version: 'v2' });

    let poll: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      poll = handler as () => void;
      return 1;
    }) as typeof window.setInterval);

    const user = userEvent.setup();
    render(<App />);
    await editCurrentDocument('# local edits');

    await act(async () => {
      poll?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('磁盘已变更')).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local edits');

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '保留本地修改' }));
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local edits');

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '重新载入磁盘版本' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# disk v2'));
  });
});
