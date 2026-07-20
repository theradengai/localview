import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopEntry, SpreadsheetWorkbookSnapshot } from '../lib/desktop';
import SpreadsheetRenderer from './SpreadsheetRenderer';

const mocks = vi.hoisted(() => ({ readSpreadsheet: vi.fn() }));

vi.mock('../lib/desktop', async () => {
  const actual = await vi.importActual<typeof import('../lib/desktop')>('../lib/desktop');
  return { ...actual, readSpreadsheet: mocks.readSpreadsheet };
});

const entry = (name: string): DesktopEntry => ({
  name,
  path: `/workspace/${name}`,
  kind: 'spreadsheet',
});

const snapshot = (label = 'Alpha'): SpreadsheetWorkbookSnapshot => ({
  version: 'v1',
  sheets: [
    { name: 'Data', index: 0, visible: true, startRow: 0, startColumn: 0, endRow: 200, endColumn: 0 },
    { name: 'Second', index: 1, visible: true, startRow: 0, startColumn: 0, endRow: 0, endColumn: 50 },
  ],
  cells: [
    { sheetIndex: 0, row: 0, column: 0, kind: 'string', displayValue: label },
    { sheetIndex: 0, row: 200, column: 0, kind: 'integer', displayValue: '201' },
    { sheetIndex: 1, row: 0, column: 0, kind: 'string', displayValue: 'Secondary' },
    { sheetIndex: 1, row: 0, column: 50, kind: 'boolean', displayValue: 'true' },
  ],
});

const tenSheetSnapshot = (): SpreadsheetWorkbookSnapshot => ({
  version: 'v1',
  sheets: ['说明', '场景', '立绘', 'CG', 'UI', '音乐', '音效', '语音', '主题包', '补素材顺序'].map((name, position) => ({
    name,
    index: position * 10,
    visible: true,
    startRow: 0,
    startColumn: 0,
    endRow: 0,
    endColumn: 0,
  })),
  cells: ['说明', '场景', '立绘', 'CG', 'UI', '音乐', '音效', '语音', '主题包', '补素材顺序'].map((name, position) => ({
    sheetIndex: position * 10,
    row: 0,
    column: 0,
    kind: 'string',
    displayValue: `${name}内容`,
  })),
});

function props(file = entry('basic.xlsx')) {
  return {
    entry: file,
    desktop: true,
    onNotice: vi.fn(),
    onQuickLook: vi.fn(async () => undefined),
    onOpenDefault: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  mocks.readSpreadsheet.mockReset();
});

describe('SpreadsheetRenderer', () => {
  it('keeps the browser demo honest without invoking Tauri', () => {
    render(<SpreadsheetRenderer {...props()} desktop={false} />);
    expect(screen.getByText(/桌面版可读取 Excel/)).toBeTruthy();
    expect(mocks.readSpreadsheet).not.toHaveBeenCalled();
  });

  it('loads one snapshot and reports the sheet count', async () => {
    mocks.readSpreadsheet.mockResolvedValue(snapshot());
    const rendererProps = props();
    render(<SpreadsheetRenderer {...rendererProps} />);

    expect(await screen.findByRole('grid', { name: 'Data 单元格' })).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(mocks.readSpreadsheet).toHaveBeenCalledOnce();
    expect(rendererProps.onNotice).toHaveBeenCalledWith('LOCALVIEW_STATUS:只读 · 2 个工作表');
  });

  it('switches sheets with a real tab button and clamps vertical and horizontal pagination', async () => {
    mocks.readSpreadsheet.mockResolvedValue(snapshot());
    render(<SpreadsheetRenderer {...props()} />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: '下 200 行' }));
    expect(await screen.findByRole('rowheader', { name: '201' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下 200 行' })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(await screen.findByText('Secondary')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Data' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('rowheader', { name: '1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '后 50 列' }));
    expect(await screen.findByRole('columnheader', { name: 'AY' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '后 50 列' })).toHaveProperty('disabled', true);
  });

  it('navigates sheets with previous and next buttons and enforces boundaries', async () => {
    mocks.readSpreadsheet.mockResolvedValue(snapshot());
    render(<SpreadsheetRenderer {...props()} />);
    await screen.findByText('Alpha');

    const previous = screen.getByRole('button', { name: '上一个工作表' });
    const next = screen.getByRole('button', { name: '下一个工作表' });
    expect(previous).toHaveProperty('disabled', true);
    expect(next).toHaveProperty('disabled', false);

    fireEvent.click(next);
    expect(await screen.findByText('Secondary')).toBeTruthy();
    expect(previous).toHaveProperty('disabled', false);
    expect(next).toHaveProperty('disabled', true);

    fireEvent.click(previous);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(previous).toHaveProperty('disabled', true);
  });

  it('supports ArrowLeft, ArrowRight, Home, and End across sheet tabs', async () => {
    mocks.readSpreadsheet.mockResolvedValue(snapshot());
    render(<SpreadsheetRenderer {...props()} />);
    await screen.findByText('Alpha');

    const dataTab = screen.getByRole('tab', { name: 'Data' });
    const secondTab = screen.getByRole('tab', { name: 'Second' });
    dataTab.focus();
    fireEvent.keyDown(dataTab, { key: 'ArrowRight' });
    expect(await screen.findByText('Secondary')).toBeTruthy();
    expect(document.activeElement).toBe(secondTab);

    fireEvent.keyDown(secondTab, { key: 'Home' });
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(document.activeElement).toBe(dataTab);

    fireEvent.keyDown(dataTab, { key: 'End' });
    expect(await screen.findByText('Secondary')).toBeTruthy();
    expect(document.activeElement).toBe(secondTab);

    fireEvent.keyDown(secondTab, { key: 'ArrowLeft' });
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(document.activeElement).toBe(dataTab);
  });

  it('renders all ten non-contiguous sheets and can click the final sheet', async () => {
    mocks.readSpreadsheet.mockResolvedValue(tenSheetSnapshot());
    render(<SpreadsheetRenderer {...props()} />);
    await screen.findByText('说明内容');

    expect(screen.getAllByRole('tab')).toHaveLength(10);
    for (const name of ['说明', '场景', '立绘', 'CG', 'UI', '音乐', '音效', '语音', '主题包', '补素材顺序']) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('tab', { name: '补素材顺序' }));
    expect(await screen.findByRole('grid', { name: '补素材顺序 单元格' })).toBeTruthy();
    expect(screen.getByText('补素材顺序内容')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '补素材顺序' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '下一个工作表' })).toHaveProperty('disabled', true);
  });

  it('shows parser failures with both system fallback actions', async () => {
    mocks.readSpreadsheet.mockRejectedValue(new Error('SPREADSHEET_PARSE_FAILED: corrupt'));
    const rendererProps = props();
    render(<SpreadsheetRenderer {...rendererProps} />);

    expect((await screen.findByRole('alert')).textContent).toContain('SPREADSHEET_PARSE_FAILED: corrupt');
    fireEvent.click(screen.getByRole('button', { name: '系统快速预览' }));
    fireEvent.click(screen.getByRole('button', { name: '用默认应用打开' }));
    await waitFor(() => expect(rendererProps.onQuickLook).toHaveBeenCalledWith('/workspace/basic.xlsx'));
    expect(rendererProps.onOpenDefault).toHaveBeenCalledWith('/workspace/basic.xlsx');
  });

  it('ignores a stale response after the selected file changes', async () => {
    let resolveFirst: ((value: SpreadsheetWorkbookSnapshot) => void) | undefined;
    let resolveSecond: ((value: SpreadsheetWorkbookSnapshot) => void) | undefined;
    mocks.readSpreadsheet
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const rendererProps = props(entry('first.xlsx'));
    const { rerender } = render(<SpreadsheetRenderer {...rendererProps} />);
    rerender(<SpreadsheetRenderer {...rendererProps} entry={entry('second.xlsx')} />);

    resolveSecond?.(snapshot('Second file'));
    expect(await screen.findByText('Second file')).toBeTruthy();
    resolveFirst?.(snapshot('Stale first file'));
    await Promise.resolve();
    expect(screen.queryByText('Stale first file')).toBeNull();
    expect(screen.getByText('Second file')).toBeTruthy();
  });
});
