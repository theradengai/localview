use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use calamine::{Data, Reader, SheetType, SheetVisible, Xls, Xlsx};
use serde::Serialize;
use tauri::{State, WebviewWindow};

use crate::{
    extension_lowercase, scoped_existing_path, version_for_bytes, workspace_for_window,
    WorkspaceRegistry, WorkspaceState,
};

pub(crate) const MAX_SOURCE_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub(crate) const MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const MAX_SHEETS: usize = 100;
pub(crate) const MAX_NON_EMPTY_CELLS: usize = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpreadsheetWorkbookSnapshot {
    pub(crate) version: String,
    pub(crate) sheets: Vec<SpreadsheetSheet>,
    pub(crate) cells: Vec<SpreadsheetCell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpreadsheetSheet {
    pub(crate) name: String,
    pub(crate) index: usize,
    pub(crate) visible: bool,
    pub(crate) start_row: u32,
    pub(crate) start_column: u32,
    pub(crate) end_row: u32,
    pub(crate) end_column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpreadsheetCell {
    pub(crate) sheet_index: usize,
    pub(crate) row: u32,
    pub(crate) column: u32,
    pub(crate) kind: SpreadsheetCellKind,
    pub(crate) display_value: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SpreadsheetCellKind {
    String,
    Integer,
    Number,
    Boolean,
    Date,
    Datetime,
    Duration,
    Error,
}

#[derive(Debug, Clone, Copy)]
struct CellBounds {
    start_row: u32,
    start_column: u32,
    end_row: u32,
    end_column: u32,
}

impl CellBounds {
    fn new(row: u32, column: u32) -> Self {
        Self {
            start_row: row,
            start_column: column,
            end_row: row,
            end_column: column,
        }
    }

    fn include(&mut self, row: u32, column: u32) {
        self.start_row = self.start_row.min(row);
        self.start_column = self.start_column.min(column);
        self.end_row = self.end_row.max(row);
        self.end_column = self.end_column.max(column);
    }
}

fn spreadsheet_error(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

fn ensure_source_size(size: u64) -> Result<(), String> {
    if size > MAX_SOURCE_BYTES {
        Err(spreadsheet_error(
            "SPREADSHEET_TOO_LARGE",
            format!("source file is {size} bytes"),
        ))
    } else {
        Ok(())
    }
}

fn ensure_archive_limits(entries: usize, uncompressed: u64) -> Result<(), String> {
    if entries > MAX_ARCHIVE_ENTRIES {
        return Err(spreadsheet_error(
            "SPREADSHEET_ARCHIVE_TOO_LARGE",
            format!("archive has {entries} entries"),
        ));
    }
    if uncompressed > MAX_UNCOMPRESSED_BYTES {
        return Err(spreadsheet_error(
            "SPREADSHEET_ARCHIVE_TOO_LARGE",
            format!("declared uncompressed size is {uncompressed} bytes"),
        ));
    }
    Ok(())
}

fn validate_archive(bytes: &[u8]) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
    let entries = archive.len();
    ensure_archive_limits(entries, 0)?;

    let mut uncompressed = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
        uncompressed = uncompressed.checked_add(file.size()).ok_or_else(|| {
            spreadsheet_error(
                "SPREADSHEET_ARCHIVE_TOO_LARGE",
                "declared uncompressed size overflow",
            )
        })?;
        ensure_archive_limits(entries, uncompressed)?;
    }

    Ok(())
}

fn format_datetime(value: calamine::ExcelDateTime) -> (SpreadsheetCellKind, String) {
    if value.is_duration() {
        let total_millis = (value.as_f64() * 86_400_000.0).round() as i64;
        let sign = if total_millis < 0 { "-" } else { "" };
        let absolute = total_millis.unsigned_abs();
        let hours = absolute / 3_600_000;
        let minutes = (absolute % 3_600_000) / 60_000;
        let seconds = (absolute % 60_000) / 1_000;
        return (
            SpreadsheetCellKind::Duration,
            format!("{sign}PT{hours}H{minutes}M{seconds}S"),
        );
    }

    let (year, month, day, hour, minute, second, _) = value.to_ymd_hms_milli();
    if hour == 0 && minute == 0 && second == 0 {
        (
            SpreadsheetCellKind::Date,
            format!("{year:04}-{month:02}-{day:02}"),
        )
    } else {
        (
            SpreadsheetCellKind::Datetime,
            format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}"),
        )
    }
}

fn format_iso_datetime(value: String) -> (SpreadsheetCellKind, String) {
    let normalized = value.replace('T', " ");
    if normalized.len() <= 10 {
        (SpreadsheetCellKind::Date, normalized)
    } else {
        let display = normalized.chars().take(19).collect();
        (SpreadsheetCellKind::Datetime, display)
    }
}

fn format_data(value: Data) -> Option<(SpreadsheetCellKind, String)> {
    match value {
        Data::Int(value) => Some((SpreadsheetCellKind::Integer, value.to_string())),
        Data::Float(value) => Some((SpreadsheetCellKind::Number, value.to_string())),
        Data::String(value) => Some((SpreadsheetCellKind::String, value)),
        Data::Bool(value) => Some((SpreadsheetCellKind::Boolean, value.to_string())),
        Data::DateTime(value) => Some(format_datetime(value)),
        Data::DateTimeIso(value) => Some(format_iso_datetime(value)),
        Data::DurationIso(value) => Some((SpreadsheetCellKind::Duration, value)),
        Data::Error(value) => Some((SpreadsheetCellKind::Error, value.to_string())),
        Data::Empty => None,
    }
}

fn push_cell(
    cells: &mut Vec<SpreadsheetCell>,
    sheet_index: usize,
    row: u32,
    column: u32,
    value: Data,
) -> Result<bool, String> {
    let Some((kind, display_value)) = format_data(value) else {
        return Ok(false);
    };
    if cells.len() >= MAX_NON_EMPTY_CELLS {
        return Err(spreadsheet_error(
            "SPREADSHEET_TOO_MANY_CELLS",
            format!("workbook exceeds {MAX_NON_EMPTY_CELLS} non-empty cells"),
        ));
    }
    cells.push(SpreadsheetCell {
        sheet_index,
        row,
        column,
        kind,
        display_value,
    });
    Ok(true)
}

fn sheet_from_bounds(
    name: String,
    index: usize,
    visible: bool,
    bounds: Option<CellBounds>,
) -> SpreadsheetSheet {
    let bounds = bounds.unwrap_or_else(|| CellBounds::new(0, 0));
    SpreadsheetSheet {
        name,
        index,
        visible,
        start_row: bounds.start_row,
        start_column: bounds.start_column,
        end_row: bounds.end_row,
        end_column: bounds.end_column,
    }
}

fn ensure_sheet_limit(count: usize) -> Result<(), String> {
    if count > MAX_SHEETS {
        Err(spreadsheet_error(
            "SPREADSHEET_TOO_MANY_SHEETS",
            format!("workbook has {count} sheets"),
        ))
    } else {
        Ok(())
    }
}

fn parse_xlsx(bytes: Vec<u8>, version: String) -> Result<SpreadsheetWorkbookSnapshot, String> {
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
    let metadata = workbook.sheets_metadata().to_vec();
    ensure_sheet_limit(metadata.len())?;

    let mut sheets = Vec::new();
    let mut cells = Vec::new();
    for sheet in metadata
        .into_iter()
        .filter(|sheet| sheet.typ == SheetType::WorkSheet)
    {
        let sheet_index = sheets.len();
        let mut reader = workbook
            .worksheet_cells_reader(&sheet.name)
            .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
        let mut bounds: Option<CellBounds> = None;
        while let Some(cell) = reader
            .next_cell()
            .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?
        {
            let (row, column) = cell.get_position();
            if push_cell(
                &mut cells,
                sheet_index,
                row,
                column,
                cell.get_value().clone().into(),
            )? {
                match &mut bounds {
                    Some(bounds) => bounds.include(row, column),
                    None => bounds = Some(CellBounds::new(row, column)),
                }
            }
        }
        sheets.push(sheet_from_bounds(
            sheet.name,
            sheet_index,
            sheet.visible == SheetVisible::Visible,
            bounds,
        ));
    }

    Ok(SpreadsheetWorkbookSnapshot {
        version,
        sheets,
        cells,
    })
}

fn parse_range_workbook<R>(
    workbook: &mut R,
    version: String,
) -> Result<SpreadsheetWorkbookSnapshot, String>
where
    R: Reader<Cursor<Vec<u8>>>,
    R::Error: std::fmt::Display,
{
    let metadata = workbook.sheets_metadata().to_vec();
    ensure_sheet_limit(metadata.len())?;

    let mut sheets = Vec::new();
    let mut cells = Vec::new();
    for sheet in metadata
        .into_iter()
        .filter(|sheet| sheet.typ == SheetType::WorkSheet)
    {
        let sheet_index = sheets.len();
        let range = workbook
            .worksheet_range(&sheet.name)
            .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
        let range_start = range.start().unwrap_or((0, 0));
        let mut bounds: Option<CellBounds> = None;
        for (relative_row, relative_column, value) in range.used_cells() {
            let row = range_start.0.saturating_add(relative_row as u32);
            let column = range_start.1.saturating_add(relative_column as u32);
            if push_cell(&mut cells, sheet_index, row, column, value.clone())? {
                match &mut bounds {
                    Some(bounds) => bounds.include(row, column),
                    None => bounds = Some(CellBounds::new(row, column)),
                }
            }
        }
        sheets.push(sheet_from_bounds(
            sheet.name,
            sheet_index,
            sheet.visible == SheetVisible::Visible,
            bounds,
        ));
    }

    Ok(SpreadsheetWorkbookSnapshot {
        version,
        sheets,
        cells,
    })
}

fn parse_csv(bytes: Vec<u8>, version: String) -> Result<SpreadsheetWorkbookSnapshot, String> {
    let bytes = bytes
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(bytes.as_slice());
    std::str::from_utf8(bytes).map_err(|error| {
        spreadsheet_error(
            "SPREADSHEET_INVALID_ENCODING",
            format!("CSV must be UTF-8 or UTF-8 with BOM: {error}"),
        )
    })?;

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes);
    let mut cells = Vec::new();
    let mut bounds: Option<CellBounds> = None;
    for (row, record) in reader.records().enumerate() {
        let record =
            record.map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
        let row = u32::try_from(row).map_err(|_| {
            spreadsheet_error("SPREADSHEET_TOO_MANY_CELLS", "CSV row index exceeds u32")
        })?;
        for (column, value) in record.iter().enumerate() {
            if value.is_empty() {
                continue;
            }
            let column = u32::try_from(column).map_err(|_| {
                spreadsheet_error("SPREADSHEET_TOO_MANY_CELLS", "CSV column index exceeds u32")
            })?;
            if push_cell(&mut cells, 0, row, column, Data::String(value.to_string()))? {
                match &mut bounds {
                    Some(bounds) => bounds.include(row, column),
                    None => bounds = Some(CellBounds::new(row, column)),
                }
            }
        }
    }

    Ok(SpreadsheetWorkbookSnapshot {
        version,
        sheets: vec![sheet_from_bounds("CSV".to_string(), 0, true, bounds)],
        cells,
    })
}

fn parse_spreadsheet(
    extension: &str,
    bytes: Vec<u8>,
    version: String,
) -> Result<SpreadsheetWorkbookSnapshot, String> {
    match extension {
        "csv" => parse_csv(bytes, version),
        "xlsx" => parse_xlsx(bytes, version),
        "xls" => {
            let mut workbook: Xls<_> = Xls::new(Cursor::new(bytes))
                .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
            parse_range_workbook(&mut workbook, version)
        }
        "ods" => {
            let mut workbook: calamine::Ods<_> = calamine::Ods::new(Cursor::new(bytes))
                .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?;
            parse_range_workbook(&mut workbook, version)
        }
        _ => Err(spreadsheet_error(
            "SPREADSHEET_UNSUPPORTED",
            format!(".{extension} is not supported by the data grid"),
        )),
    }
}

fn spreadsheet_path(state: &WorkspaceState, path: &Path) -> Result<PathBuf, String> {
    let path = scoped_existing_path(state, path).map_err(|error| {
        if error == "Path is outside the active workspace" {
            spreadsheet_error("PATH_OUTSIDE_WORKSPACE", error)
        } else {
            error
        }
    })?;
    if !path.is_file() {
        return Err(spreadsheet_error(
            "SPREADSHEET_UNSUPPORTED",
            "the requested path is not a regular file",
        ));
    }

    let extension = extension_lowercase(&path);
    if !matches!(extension.as_str(), "csv" | "xls" | "xlsx" | "ods") {
        return Err(spreadsheet_error(
            "SPREADSHEET_UNSUPPORTED",
            format!("{} is not a supported spreadsheet", path.display()),
        ));
    }

    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    ensure_source_size(metadata.len())?;
    Ok(path)
}

#[tauri::command]
pub(crate) async fn read_spreadsheet(
    path: String,
    window: WebviewWindow,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<SpreadsheetWorkbookSnapshot, String> {
    let state = workspace_for_window(&registry, &window)?;
    let path = spreadsheet_path(&state, Path::new(&path))?;
    let extension = extension_lowercase(&path);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    if matches!(extension.as_str(), "xlsx" | "ods") {
        validate_archive(&bytes)?;
    }
    let version = version_for_bytes(&bytes);

    tauri::async_runtime::spawn_blocking(move || parse_spreadsheet(&extension, bytes, version))
        .await
        .map_err(|error| spreadsheet_error("SPREADSHEET_PARSE_FAILED", error))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        )
        .expect("read fixture")
    }

    fn assert_basic_fixture(extension: &str) {
        let bytes = fixture(&format!("basic.{extension}"));
        if matches!(extension, "xlsx" | "ods") {
            validate_archive(&bytes).expect("fixture archive should pass preflight");
        }
        let snapshot = parse_spreadsheet(extension, bytes, "fixture-version".to_string())
            .expect("parse fixture");
        assert_eq!(snapshot.version, "fixture-version");
        assert_eq!(snapshot.sheets.len(), 2);
        assert_eq!(snapshot.sheets[0].name, "Data");
        assert_eq!(snapshot.sheets[1].name, "Second");
        assert!(snapshot.cells.iter().any(|cell| {
            cell.sheet_index == 0
                && cell.display_value == "Alpha"
                && cell.kind == SpreadsheetCellKind::String
        }));
        assert!(snapshot.cells.iter().any(|cell| {
            cell.sheet_index == 0
                && cell.display_value == "42"
                && matches!(
                    cell.kind,
                    SpreadsheetCellKind::Integer | SpreadsheetCellKind::Number
                )
        }));
        assert!(snapshot.cells.iter().any(|cell| {
            cell.sheet_index == 1
                && cell.display_value == "Secondary"
                && cell.kind == SpreadsheetCellKind::String
        }));
    }

    #[test]
    fn parses_xlsx_fixture() {
        assert_basic_fixture("xlsx");
    }

    #[test]
    fn parses_xls_fixture() {
        assert_basic_fixture("xls");
    }

    #[test]
    fn parses_ods_fixture() {
        assert_basic_fixture("ods");
    }

    #[test]
    fn parses_csv_fixture_as_one_text_preserving_sheet() {
        let snapshot = parse_spreadsheet("csv", fixture("basic.csv"), "csv-v1".to_string())
            .expect("parse CSV fixture");

        assert_eq!(snapshot.version, "csv-v1");
        assert_eq!(snapshot.sheets.len(), 1);
        assert_eq!(snapshot.sheets[0].name, "CSV");
        assert_eq!(snapshot.sheets[0].end_row, 4);
        assert_eq!(snapshot.sheets[0].end_column, 2);
        assert!(snapshot
            .cells
            .iter()
            .any(|cell| { cell.row == 0 && cell.column == 0 && cell.display_value == "Name" }));
        assert!(snapshot
            .cells
            .iter()
            .any(|cell| { cell.row == 1 && cell.column == 1 && cell.display_value == "00123" }));
        assert!(snapshot.cells.iter().any(|cell| {
            cell.row == 1 && cell.column == 2 && cell.display_value == "quoted, value"
        }));
        assert!(snapshot.cells.iter().any(|cell| {
            cell.row == 2 && cell.column == 2 && cell.display_value == "line one\nline two"
        }));
        assert!(snapshot.cells.iter().any(|cell| {
            cell.row == 4 && cell.column == 2 && cell.display_value == "said \"hello\""
        }));
        assert!(snapshot
            .cells
            .iter()
            .all(|cell| cell.kind == SpreadsheetCellKind::String));
    }

    #[test]
    fn parses_utf8_bom_and_empty_csv() {
        let snapshot = parse_csv(
            b"\xef\xbb\xbfname,value\n\xe4\xb8\xad\xe6\x96\x87,001".to_vec(),
            "bom-v1".to_string(),
        )
        .expect("parse UTF-8 BOM CSV");
        assert!(snapshot
            .cells
            .iter()
            .any(|cell| cell.display_value == "name"));
        assert!(snapshot
            .cells
            .iter()
            .any(|cell| cell.display_value == "中文"));
        assert!(snapshot
            .cells
            .iter()
            .any(|cell| cell.display_value == "001"));

        let empty = parse_csv(Vec::new(), "empty-v1".to_string()).expect("parse empty CSV");
        assert_eq!(empty.sheets.len(), 1);
        assert!(empty.cells.is_empty());
        assert_eq!(empty.sheets[0].end_row, 0);
        assert_eq!(empty.sheets[0].end_column, 0);
    }

    #[test]
    fn rejects_non_utf8_csv_with_stable_error() {
        let error = parse_csv(b"name\n\xff".to_vec(), "invalid-v1".to_string())
            .expect_err("non-UTF-8 CSV should fail");
        assert!(error.starts_with("SPREADSHEET_INVALID_ENCODING:"));
    }

    #[test]
    fn enforces_csv_non_empty_cell_limit() {
        let mut source = String::with_capacity((MAX_NON_EMPTY_CELLS + 1) * 2);
        for _ in 0..=MAX_NON_EMPTY_CELLS {
            source.push_str("x\n");
        }
        let error = parse_csv(source.into_bytes(), "large-v1".to_string())
            .expect_err("CSV cell limit should fail");
        assert!(error.starts_with("SPREADSHEET_TOO_MANY_CELLS:"));
    }

    #[test]
    fn formats_supported_cell_values() {
        assert_eq!(
            format_data(Data::Int(42)),
            Some((SpreadsheetCellKind::Integer, "42".to_string()))
        );
        assert_eq!(
            format_data(Data::Float(3.5)),
            Some((SpreadsheetCellKind::Number, "3.5".to_string()))
        );
        assert_eq!(
            format_data(Data::DateTimeIso("2026-07-20T12:30:54".to_string())),
            Some((
                SpreadsheetCellKind::Datetime,
                "2026-07-20 12:30:54".to_string()
            ))
        );
        assert_eq!(format_data(Data::Empty), None);
    }

    #[test]
    fn rejects_corrupt_archives() {
        let error = validate_archive(&fixture("corrupt.xlsx")).expect_err("archive should fail");
        assert!(error.starts_with("SPREADSHEET_PARSE_FAILED:"));
    }

    #[test]
    fn enforces_sheet_and_cell_limits() {
        assert!(ensure_source_size(MAX_SOURCE_BYTES).is_ok());
        assert!(ensure_source_size(MAX_SOURCE_BYTES + 1)
            .expect_err("source size limit should fail")
            .starts_with("SPREADSHEET_TOO_LARGE:"));
        assert!(ensure_archive_limits(MAX_ARCHIVE_ENTRIES, MAX_UNCOMPRESSED_BYTES).is_ok());
        assert!(ensure_archive_limits(MAX_ARCHIVE_ENTRIES + 1, 0)
            .expect_err("archive entry limit should fail")
            .starts_with("SPREADSHEET_ARCHIVE_TOO_LARGE:"));
        assert!(ensure_sheet_limit(MAX_SHEETS).is_ok());
        assert!(ensure_sheet_limit(MAX_SHEETS + 1)
            .expect_err("sheet limit should fail")
            .starts_with("SPREADSHEET_TOO_MANY_SHEETS:"));

        let mut cells = Vec::with_capacity(MAX_NON_EMPTY_CELLS);
        for index in 0..MAX_NON_EMPTY_CELLS {
            cells.push(SpreadsheetCell {
                sheet_index: 0,
                row: index as u32,
                column: 0,
                kind: SpreadsheetCellKind::Integer,
                display_value: index.to_string(),
            });
        }
        let error =
            push_cell(&mut cells, 0, 0, 0, Data::Int(1)).expect_err("cell limit should fail");
        assert!(error.starts_with("SPREADSHEET_TOO_MANY_CELLS:"));
    }

    #[test]
    fn rejects_archives_over_declared_size_limit() {
        use std::io::Write;

        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer
                .start_file("oversized.bin", options)
                .expect("start file");
            let chunk = vec![0_u8; 1024 * 1024];
            for _ in 0..=128 {
                writer.write_all(&chunk).expect("write oversized entry");
            }
            writer.finish().expect("finish archive");
        }

        let error = validate_archive(bytes.get_ref()).expect_err("archive limit should fail");
        assert!(error.starts_with("SPREADSHEET_ARCHIVE_TOO_LARGE:"));
    }

    #[test]
    fn unsupported_extension_has_stable_error_code() {
        let error = parse_spreadsheet("numbers", Vec::new(), "v1".to_string())
            .expect_err("unsupported extension should fail");
        assert!(error.starts_with("SPREADSHEET_UNSUPPORTED:"));
    }

    #[test]
    fn path_extension_matching_is_case_insensitive() {
        assert_eq!(
            extension_lowercase(std::path::Path::new("Budget.XLSX")),
            "xlsx"
        );
        assert_eq!(
            extension_lowercase(std::path::Path::new("Export.CSV")),
            "csv"
        );
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let unique = format!(
            "localview-spreadsheet-path-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let workspace = root.join("workspace");
        let outside = root.join("outside.xlsx");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::write(&outside, fixture("basic.xlsx")).expect("create outside file");
        let state = WorkspaceState {
            context: std::sync::Mutex::new(crate::WorkspaceContext {
                root: Some(crate::open_workspace_root(&workspace).expect("open workspace")),
                generation: 1,
                asset_scope: "spreadsheet-test-scope".to_string(),
                watcher: None,
            }),
            next_generation: std::sync::atomic::AtomicU64::new(1),
            next_asset_id: std::sync::atomic::AtomicU64::new(1),
        };

        let error = spreadsheet_path(&state, &outside).expect_err("outside path should fail");
        assert!(error.starts_with("PATH_OUTSIDE_WORKSPACE:"));

        fs::remove_dir_all(root).expect("remove path test directory");
    }
}
