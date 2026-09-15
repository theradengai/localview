import { useI18n } from '../lib/useI18n';
import { t } from '../lib/i18n';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  readSpreadsheet,
  type DesktopEntry,
  type SpreadsheetWorkbookSnapshot,
} from '../lib/desktop';

const ROW_PAGE_SIZE = 200;
const COLUMN_PAGE_SIZE = 50;
const STATUS_PREFIX = 'LOCALVIEW_STATUS:';

type SpreadsheetRendererProps = {
  entry: DesktopEntry;
  desktop: boolean;
  onNotice(message: string): void;
  onQuickLook(path: string): Promise<void>;
  onOpenDefault(path: string): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function columnLabel(column: number): string {
  let value = column + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export default function SpreadsheetRenderer({
  entry,
  desktop,
  onNotice,
  onQuickLook,
  onOpenDefault,
}: SpreadsheetRendererProps) {
  const { locale } = useI18n();
  const [statusMessage, setStatusMessage] = useState<{ key: string; values: (string | number)[] } | null>(null);
  useEffect(() => {
    if (statusMessage) onNotice(t(statusMessage.key, ...statusMessage.values));
  }, [statusMessage, locale, onNotice]);


  const requestEpochRef = useRef(0);
  const sheetTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [snapshot, setSnapshot] = useState<SpreadsheetWorkbookSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(desktop);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowStart, setRowStart] = useState(0);
  const [columnStart, setColumnStart] = useState(0);

  useEffect(() => {
    const epoch = ++requestEpochRef.current;
    setSnapshot(null);
    setError('');
    setSheetIndex(0);
    setRowStart(0);
    setColumnStart(0);

    if (!desktop) {
      setLoading(false);
      setStatusMessage({ key: "{0}桌面版可读取表格", values: [STATUS_PREFIX] });
      return () => { requestEpochRef.current += 1; };
    }

    setLoading(true);
    void readSpreadsheet(entry.path)
      .then((next) => {
        if (requestEpochRef.current !== epoch) return;
        setSnapshot(next);
        const first = next.sheets[0];
        setSheetIndex(first?.index ?? 0);
        setRowStart(first?.startRow ?? 0);
        setColumnStart(first?.startColumn ?? 0);
        setStatusMessage({ key: "{0}只读 · {1} 个工作表", values: [STATUS_PREFIX, next.sheets.length] });
      })
      .catch((reason) => {
        if (requestEpochRef.current !== epoch) return;
        const message = errorMessage(reason);
        setError(message);
        setStatusMessage({ key: "{0}只读 · Spreadsheet", values: [STATUS_PREFIX] });
      })
      .finally(() => {
        if (requestEpochRef.current === epoch) setLoading(false);
      });

    return () => { requestEpochRef.current += 1; };
  }, [desktop, entry.path, onNotice]);

  const cellLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const cell of snapshot?.cells ?? []) {
      lookup.set(`${cell.sheetIndex}:${cell.row}:${cell.column}`, cell.displayValue);
    }
    return lookup;
  }, [snapshot]);

  const selectedSheet = snapshot?.sheets.find((sheet) => sheet.index === sheetIndex) ?? snapshot?.sheets[0];
  const selectedSheetPosition = selectedSheet
    ? snapshot?.sheets.findIndex((sheet) => sheet.index === selectedSheet.index) ?? -1
    : -1;
  const hasCells = selectedSheet
    ? snapshot?.cells.some((cell) => cell.sheetIndex === selectedSheet.index) ?? false
    : false;
  const rowEnd = selectedSheet ? Math.min(selectedSheet.endRow, rowStart + ROW_PAGE_SIZE - 1) : 0;
  const columnEnd = selectedSheet ? Math.min(selectedSheet.endColumn, columnStart + COLUMN_PAGE_SIZE - 1) : 0;
  const rows = selectedSheet && hasCells
    ? Array.from({ length: rowEnd - rowStart + 1 }, (_, index) => rowStart + index)
    : [];
  const columns = selectedSheet && hasCells
    ? Array.from({ length: columnEnd - columnStart + 1 }, (_, index) => columnStart + index)
    : [];

  function selectSheet(nextIndex: number) {
    const next = snapshot?.sheets.find((sheet) => sheet.index === nextIndex);
    if (!next) return;
    setSheetIndex(next.index);
    setRowStart(next.startRow);
    setColumnStart(next.startColumn);
  }

  function selectSheetAt(position: number) {
    const next = snapshot?.sheets[position];
    if (!next) return;
    selectSheet(next.index);
  }

  function handleSheetTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, position: number) {
    if (!snapshot) return;

    let nextPosition: number | null = null;
    if (event.key === 'ArrowLeft') nextPosition = Math.max(0, position - 1);
    if (event.key === 'ArrowRight') nextPosition = Math.min(snapshot.sheets.length - 1, position + 1);
    if (event.key === 'Home') nextPosition = 0;
    if (event.key === 'End') nextPosition = snapshot.sheets.length - 1;
    if (nextPosition === null) return;

    event.preventDefault();
    selectSheetAt(nextPosition);
    sheetTabRefs.current[nextPosition]?.focus();
  }

  async function runAction(action: (path: string) => Promise<void>) {
    try {
      await action(entry.path);
    } catch (reason) {
      onNotice(errorMessage(reason));
    }
  }

  if (!desktop) {
    return <div className="empty-state spreadsheet-fallback">
      <strong>{entry.name}</strong>
      <span>{t("桌面版可读取 CSV、Excel、ODS 的已保存单元格；浏览器 Demo 不访问本地文件。")}</span>
    </div>;
  }

  if (loading) {
    return <div className="empty-state"><strong>{t("正在读取表格…")}</strong><span>{entry.name}</span></div>;
  }

  if (error) {
    return <div className="empty-state spreadsheet-fallback" role="alert">
      <strong>{t("无法读取表格")}</strong>
      <span>{error}</span>
      <div className="renderer-actions">
        <button onClick={() => void runAction(onQuickLook)}>{t("系统快速预览")}</button>
        <button onClick={() => void runAction(onOpenDefault)}>{t("用默认应用打开")}</button>
      </div>
    </div>;
  }

  if (!snapshot || !selectedSheet) {
    return <div className="empty-state"><strong>{t("工作簿没有可显示的工作表")}</strong></div>;
  }

  return <div className="spreadsheet-renderer">
    <div className="spreadsheet-toolbar">
      <div className="spreadsheet-pager" aria-label={t("表格分页")}>
        <button
          disabled={!hasCells || rowStart <= selectedSheet.startRow}
          onClick={() => setRowStart(Math.max(selectedSheet.startRow, rowStart - ROW_PAGE_SIZE))}
        >{t("上 200 行")}</button>
        <span>{hasCells ? t("{0}–{1} 行", rowStart + 1, rowEnd + 1) : t("空工作表")}</span>
        <button
          disabled={!hasCells || rowEnd >= selectedSheet.endRow}
          onClick={() => setRowStart(Math.min(selectedSheet.endRow, rowStart + ROW_PAGE_SIZE))}
        >{t("下 200 行")}</button>
        <button
          disabled={!hasCells || columnStart <= selectedSheet.startColumn}
          onClick={() => setColumnStart(Math.max(selectedSheet.startColumn, columnStart - COLUMN_PAGE_SIZE))}
        >{t("前 50 列")}</button>
        <span>{hasCells ? t("{0}–{1} 列", columnLabel(columnStart), columnLabel(columnEnd)) : ''}</span>
        <button
          disabled={!hasCells || columnEnd >= selectedSheet.endColumn}
          onClick={() => setColumnStart(Math.min(selectedSheet.endColumn, columnStart + COLUMN_PAGE_SIZE))}
        >{t("后 50 列")}</button>
      </div>
      <div className="renderer-actions">
        <button onClick={() => void runAction(onQuickLook)}>{t("系统快速预览")}</button>
        <button onClick={() => void runAction(onOpenDefault)}>{t("默认应用")}</button>
      </div>
    </div>
    {hasCells ? <div className="spreadsheet-grid-scroll">
      <div
        className="spreadsheet-grid"
        role="grid"
        aria-label={t("{0} 单元格", selectedSheet.name)}
        style={{ gridTemplateColumns: `52px repeat(${columns.length}, 120px)` }}
      >
        <div className="spreadsheet-corner" role="columnheader" />
        {columns.map((column) => <div className="spreadsheet-column-header" role="columnheader" key={`column-${column}`}>
          {columnLabel(column)}
        </div>)}
        {rows.flatMap((row) => [
          <div className="spreadsheet-row-header" role="rowheader" key={`row-${row}`}>{row + 1}</div>,
          ...columns.map((column) => <div
            className="spreadsheet-cell"
            role="gridcell"
            key={`${row}:${column}`}
            title={cellLookup.get(`${selectedSheet.index}:${row}:${column}`) ?? ''}
          >
            {cellLookup.get(`${selectedSheet.index}:${row}:${column}`) ?? ''}
          </div>),
        ])}
      </div>
    </div> : <div className="empty-state"><strong>{selectedSheet.name}</strong><span>{t("这个工作表没有已保存的单元格。")}</span></div>}
    <div className="spreadsheet-sheet-nav">
      <button
        className="spreadsheet-sheet-step"
        aria-label={t("上一个工作表")}
        disabled={selectedSheetPosition <= 0}
        onClick={() => selectSheetAt(selectedSheetPosition - 1)}
      >‹</button>
      <div className="spreadsheet-sheet-tabs" role="tablist" aria-label={t("工作表")}>
        {snapshot.sheets.map((sheet, position) => {
          const active = sheet.index === selectedSheet.index;
          const label = `${sheet.name}${sheet.visible ? '' : t("（隐藏）")}`;
          return <button
            key={sheet.index}
            ref={(element) => { sheetTabRefs.current[position] = element; }}
            className={`spreadsheet-sheet-tab${active ? ' active' : ''}${sheet.visible ? '' : ' hidden'}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={label}
            onClick={() => selectSheet(sheet.index)}
            onKeyDown={(event) => handleSheetTabKeyDown(event, position)}
          >{label}</button>;
        })}
      </div>
      <button
        className="spreadsheet-sheet-step"
        aria-label={t("下一个工作表")}
        disabled={selectedSheetPosition < 0 || selectedSheetPosition >= snapshot.sheets.length - 1}
        onClick={() => selectSheetAt(selectedSheetPosition + 1)}
      >›</button>
    </div>
  </div>;
}
