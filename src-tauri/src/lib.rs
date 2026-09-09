use notify_debouncer_full::{
    new_debouncer_opt,
    notify::{
        event::ModifyKind, Config as NotifyConfig, EventKind, RecommendedWatcher, RecursiveMode,
    },
    DebounceEventResult, Debouncer, NoCache,
};
use percent_encoding::percent_decode_str;
#[cfg(unix)]
use rustix::{
    fd::OwnedFd,
    fs::{self as unix_fs, AtFlags, FileType, Mode, OFlags, RenameFlags},
    io::{fcntl_dupfd_cloexec, Errno},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{header, Response, StatusCode},
    Emitter, Manager, WebviewWindow,
};

#[cfg(target_os = "macos")]
use objc2::rc::autoreleasepool;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString, NSURL};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

mod image_paste;
mod quick_look;
mod spreadsheet;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextFileSnapshot {
    content: String,
    version: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: String,
    message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn io(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
            std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            _ => "IO_ERROR",
        };
        Self::new(code, error.to_string())
    }

    fn legacy(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let code = if message.starts_with("EXTERNAL_CHANGE") {
            "EXTERNAL_CHANGE"
        } else if message.starts_with("WORKSPACE_ROOT_CHANGED")
            || message.starts_with("WORKSPACE_CHANGED")
        {
            "WORKSPACE_CHANGED"
        } else if message.starts_with("TRASH_TARGET_CHANGED") {
            "TRASH_TARGET_CHANGED"
        } else if message.starts_with("TRASH_ROOT_FORBIDDEN") {
            "TRASH_ROOT_FORBIDDEN"
        } else if message.starts_with("TRASH_SYMLINK_UNSUPPORTED") {
            "TRASH_SYMLINK_UNSUPPORTED"
        } else if message.starts_with("TRASH_UNSUPPORTED") {
            "TRASH_UNSUPPORTED"
        } else if lower.contains("no such file")
            || lower.contains("not found")
            || lower.contains("os error 2")
        {
            "FILE_NOT_FOUND"
        } else if lower.contains("permission denied") || lower.contains("os error 13") {
            "PERMISSION_DENIED"
        } else {
            "IO_ERROR"
        };
        Self::new(code, message)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedTextFile {
    entry: FsEntry,
    snapshot: TextFileSnapshot,
}

const WATCH_BACKEND_DEBOUNCE_MS: u64 = 120;
type WorkspaceDebouncer = Debouncer<RecommendedWatcher, NoCache>;

#[derive(Default)]
pub(crate) struct WorkspaceState {
    context: Mutex<WorkspaceContext>,
    next_generation: AtomicU64,
    next_asset_id: AtomicU64,
}

#[derive(Default)]
pub(crate) struct WorkspaceRegistry {
    contexts: Mutex<HashMap<String, Arc<WorkspaceState>>>,
    retired: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct PreviewState {
    capabilities: Mutex<HashMap<String, PreviewCapability>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
struct PreviewCapability {
    window_label: String,
    root: PathBuf,
    document: PathBuf,
    workspace_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlPreviewCapability {
    token: String,
    document_path: String,
    workspace_generation: u64,
}

#[derive(Default)]
#[allow(dead_code)]
struct WorkspaceContext {
    root: Option<WorkspaceRoot>,
    generation: u64,
    asset_scope: String,
    watcher: Option<WorkspaceDebouncer>,
}

struct WorkspaceRoot {
    path: PathBuf,
    #[cfg(unix)]
    directory: OwnedFd,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBinding {
    path: String,
    generation: u64,
    watching: bool,
    asset_scope: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum WorkspaceFsEventKind {
    Create,
    Modify,
    Remove,
    Rename,
    Rescan,
    Other,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFsEvent {
    kind: WorkspaceFsEventKind,
    paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeBatch {
    root_path: String,
    generation: u64,
    events: Vec<WorkspaceFsEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWatchFailure {
    root_path: String,
    generation: u64,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashedItem {
    original_path: String,
    trashed_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrashCandidate {
    original_path: String,
    workspace_generation: u64,
    parent_identity: String,
    target_identity: String,
    is_dir: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MoveCandidate {
    source_path: String,
    destination_directory: String,
    destination_path: String,
    workspace_generation: u64,
    source_parent_identity: String,
    source_identity: String,
    destination_identity: String,
    source_is_directory: bool,
    source_is_bundle: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MovedWorkspaceEntry {
    original_path: String,
    moved_path: String,
    entry: FsEntry,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum MoveReconciliationOutcome {
    Source,
    Destination,
    Ambiguous,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MoveReconciliation {
    outcome: MoveReconciliationOutcome,
    entry: Option<FsEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RenameCandidate {
    source_path: String,
    destination_path: String,
    workspace_generation: u64,
    parent_identity: String,
    source_identity: String,
    source_is_directory: bool,
    source_is_bundle: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RenamedWorkspaceEntry {
    original_path: String,
    renamed_path: String,
    entry: FsEntry,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RenameReconciliationOutcome {
    Source,
    Destination,
    Ambiguous,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RenameReconciliation {
    outcome: RenameReconciliationOutcome,
    entry: Option<FsEntry>,
}

impl WorkspaceRegistry {
    fn workspace_for_label(&self, label: &str) -> Result<Arc<WorkspaceState>, String> {
        if self
            .retired
            .lock()
            .map_err(|_| "Workspace registry is unavailable".to_string())?
            .contains(label)
        {
            return Err("WINDOW_DESTROYED".to_string());
        }
        let mut contexts = self
            .contexts
            .lock()
            .map_err(|_| "Workspace registry is unavailable".to_string())?;
        Ok(Arc::clone(
            contexts
                .entry(label.to_string())
                .or_insert_with(|| Arc::new(WorkspaceState::default())),
        ))
    }

    #[cfg(test)]
    fn existing_workspace(&self, label: &str) -> Result<Option<Arc<WorkspaceState>>, String> {
        Ok(self
            .contexts
            .lock()
            .map_err(|_| "Workspace registry is unavailable".to_string())?
            .get(label)
            .map(Arc::clone))
    }

    fn retire(&self, label: &str) -> Result<(), String> {
        self.contexts
            .lock()
            .map_err(|_| "Workspace registry is unavailable".to_string())?
            .remove(label);
        self.retired
            .lock()
            .map_err(|_| "Workspace registry is unavailable".to_string())?
            .insert(label.to_string());
        Ok(())
    }
}

pub(crate) fn workspace_for_window(
    registry: &WorkspaceRegistry,
    window: &WebviewWindow,
) -> Result<Arc<WorkspaceState>, String> {
    registry.workspace_for_label(window.label())
}

fn opaque_scope(parts: impl IntoIterator<Item = String>) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn asset_scope_for(state: &WorkspaceState, window_label: &str, generation: u64) -> String {
    let id = state.next_asset_id.fetch_add(1, Ordering::SeqCst) + 1;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    opaque_scope([
        std::process::id().to_string(),
        window_label.to_string(),
        generation.to_string(),
        id.to_string(),
        timestamp.to_string(),
    ])
}

fn extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd"];
const HTML_EXTENSIONS: &[&str] = &["html", "htm"];
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "json", "jsonc", "yaml", "yml", "toml", "xml", "css", "js", "jsx", "ts", "tsx", "rs",
    "py", "sh", "log",
];
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
];
const PDF_EXTENSIONS: &[&str] = &["pdf"];
const SPREADSHEET_EXTENSIONS: &[&str] = &["csv", "xls", "xlsx", "ods", "numbers"];
const DOCUMENT_EXTENSIONS: &[&str] = &["doc", "docx", "odt", "rtf", "pages"];
const PRESENTATION_EXTENSIONS: &[&str] = &["ppt", "pptx", "odp", "key"];
const IWORK_BUNDLE_EXTENSIONS: &[&str] = &["numbers", "pages", "key"];

fn file_kind_from_extension(extension: &str) -> &'static str {
    if MARKDOWN_EXTENSIONS.contains(&extension) {
        "md"
    } else if HTML_EXTENSIONS.contains(&extension) {
        "html"
    } else if TEXT_EXTENSIONS.contains(&extension) {
        "text"
    } else if IMAGE_EXTENSIONS.contains(&extension) {
        "image"
    } else if PDF_EXTENSIONS.contains(&extension) {
        "pdf"
    } else if SPREADSHEET_EXTENSIONS.contains(&extension) {
        "spreadsheet"
    } else if DOCUMENT_EXTENSIONS.contains(&extension) {
        "document"
    } else if PRESENTATION_EXTENSIONS.contains(&extension) {
        "presentation"
    } else {
        "other"
    }
}

fn is_document_bundle(path: &Path, is_dir: bool) -> bool {
    is_dir && IWORK_BUNDLE_EXTENSIONS.contains(&extension_lowercase(path).as_str())
}

fn file_kind(path: &Path, is_dir: bool) -> String {
    if is_document_bundle(path, is_dir) {
        return file_kind_from_extension(&extension_lowercase(path)).into();
    }

    if is_dir {
        return "folder".into();
    }

    file_kind_from_extension(&extension_lowercase(path)).into()
}

fn entry_from_path(path: &Path) -> Result<FsEntry, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    Ok(FsEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: file_kind(path, metadata.is_dir()),
    })
}

fn active_workspace_root(state: &WorkspaceState) -> Result<PathBuf, String> {
    state
        .context
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?
        .root
        .as_ref()
        .map(|root| root.path.clone())
        .ok_or_else(|| "Open a workspace before accessing files".to_string())
}

fn active_workspace_snapshot(state: &WorkspaceState) -> Result<(PathBuf, u64), String> {
    let context = state
        .context
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?;
    let root = context
        .root
        .as_ref()
        .ok_or_else(|| "Open a workspace before accessing files".to_string())?;
    Ok((root.path.clone(), context.generation))
}

fn active_workspace_binding_snapshot(
    state: &WorkspaceState,
) -> Result<(PathBuf, u64, String), String> {
    let context = state
        .context
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?;
    let root = context
        .root
        .as_ref()
        .ok_or_else(|| "Open a workspace before accessing files".to_string())?;
    Ok((
        root.path.clone(),
        context.generation,
        context.asset_scope.clone(),
    ))
}

#[cfg(unix)]
fn active_workspace_capability(state: &WorkspaceState) -> Result<WorkspaceRoot, String> {
    active_workspace_capability_with_generation(state).map(|(root, _)| root)
}

#[cfg(unix)]
fn active_workspace_capability_with_generation(
    state: &WorkspaceState,
) -> Result<(WorkspaceRoot, u64), String> {
    let context = state
        .context
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?;
    let root = context
        .root
        .as_ref()
        .ok_or_else(|| "Open a workspace before accessing files".to_string())?;
    let directory = fcntl_dupfd_cloexec(&root.directory, 0)
        .map_err(|error| format!("Workspace directory handle is unavailable: {error}"))?;
    Ok((
        WorkspaceRoot {
            path: root.path.clone(),
            directory,
            device: root.device,
            inode: root.inode,
        },
        context.generation,
    ))
}

fn open_workspace_root(path: &Path) -> Result<WorkspaceRoot, String> {
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        let directory = unix_fs::open(
            &canonical,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("Unable to open the selected workspace: {error}"))?;
        let handle_stat = unix_fs::fstat(&directory)
            .map_err(|error| format!("Unable to inspect the selected workspace: {error}"))?;
        if !FileType::from_raw_mode(handle_stat.st_mode).is_dir() {
            return Err("The selected workspace is not a directory".to_string());
        }
        let path_stat =
            unix_fs::stat(&canonical).map_err(|_| "WORKSPACE_ROOT_CHANGED".to_string())?;
        if handle_stat.st_dev != path_stat.st_dev || handle_stat.st_ino != path_stat.st_ino {
            return Err("WORKSPACE_ROOT_CHANGED".to_string());
        }
        return Ok(WorkspaceRoot {
            path: canonical,
            directory,
            device: handle_stat.st_dev as u64,
            inode: handle_stat.st_ino as u64,
        });
    }

    #[cfg(not(unix))]
    {
        if !canonical.is_dir() {
            return Err("The selected workspace is not a directory".to_string());
        }
        Ok(WorkspaceRoot { path: canonical })
    }
}

#[cfg(test)]
fn commit_workspace_root(
    state: &WorkspaceState,
    root: WorkspaceRoot,
    watcher: Option<WorkspaceDebouncer>,
) -> Result<WorkspaceBinding, String> {
    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
    commit_workspace_candidate_for_label(state, root, watcher, generation, "test")
}

#[cfg(test)]
fn commit_workspace_candidate(
    state: &WorkspaceState,
    root: WorkspaceRoot,
    watcher: Option<WorkspaceDebouncer>,
    generation: u64,
) -> Result<WorkspaceBinding, String> {
    commit_workspace_candidate_for_label(state, root, watcher, generation, "test")
}

fn commit_workspace_candidate_for_label(
    state: &WorkspaceState,
    root: WorkspaceRoot,
    watcher: Option<WorkspaceDebouncer>,
    generation: u64,
    window_label: &str,
) -> Result<WorkspaceBinding, String> {
    let root_path = root.path.clone();
    let watching = watcher.is_some();
    let asset_scope = asset_scope_for(state, window_label, generation);
    let mut context = state
        .context
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?;
    if generation <= context.generation {
        return Err("WORKSPACE_ROOT_SUPERSEDED".to_string());
    }
    *context = WorkspaceContext {
        root: Some(root),
        generation,
        asset_scope: asset_scope.clone(),
        watcher,
    };
    Ok(WorkspaceBinding {
        path: root_path.to_string_lossy().into_owned(),
        generation,
        watching,
        asset_scope,
    })
}

#[cfg(test)]
fn set_workspace_root_impl(
    state: &WorkspaceState,
    path: &Path,
) -> Result<WorkspaceBinding, String> {
    let root = open_workspace_root(path)?;
    commit_workspace_root(state, root, None)
}

fn is_ignored_watch_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    name == ".DS_Store"
        || (name.starts_with('.') && name.contains(".localview-") && name.ends_with(".tmp"))
}

fn watch_event_kind(kind: &EventKind, needs_rescan: bool) -> WorkspaceFsEventKind {
    if needs_rescan {
        return WorkspaceFsEventKind::Rescan;
    }
    match kind {
        EventKind::Create(_) => WorkspaceFsEventKind::Create,
        EventKind::Modify(ModifyKind::Name(_)) => WorkspaceFsEventKind::Rename,
        EventKind::Modify(_) => WorkspaceFsEventKind::Modify,
        EventKind::Remove(_) => WorkspaceFsEventKind::Remove,
        EventKind::Other => WorkspaceFsEventKind::Other,
        _ => WorkspaceFsEventKind::Other,
    }
}

fn map_watch_event(
    root: &Path,
    kind: &EventKind,
    paths: &[PathBuf],
    needs_rescan: bool,
) -> Option<WorkspaceFsEvent> {
    let mut seen = HashSet::new();
    let mapped = paths
        .iter()
        .filter(|path| (*path == root || path.starts_with(root)) && !is_ignored_watch_path(path))
        .filter_map(|path| {
            let value = path.to_string_lossy().into_owned();
            seen.insert(value.clone()).then_some(value)
        })
        .collect::<Vec<_>>();
    if mapped.is_empty() && !needs_rescan {
        return None;
    }
    Some(WorkspaceFsEvent {
        kind: watch_event_kind(kind, needs_rescan),
        paths: mapped,
    })
}

fn create_workspace_watcher(
    app: tauri::AppHandle,
    window_label: String,
    root: PathBuf,
    generation: u64,
) -> Result<WorkspaceDebouncer, String> {
    let callback_root = root.clone();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        Duration::from_millis(WATCH_BACKEND_DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let mapped = events
                    .iter()
                    .filter_map(|event| {
                        map_watch_event(
                            &callback_root,
                            &event.kind,
                            &event.paths,
                            event.need_rescan(),
                        )
                    })
                    .collect::<Vec<_>>();
                if !mapped.is_empty() {
                    let _ = app.emit_to(
                        &window_label,
                        "workspace-directory-changed",
                        WorkspaceChangeBatch {
                            root_path: callback_root.to_string_lossy().into_owned(),
                            generation,
                            events: mapped,
                        },
                    );
                }
            }
            Err(errors) => {
                let message = errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ");
                let _ = app.emit_to(
                    &window_label,
                    "workspace-watch-failed",
                    WorkspaceWatchFailure {
                        root_path: callback_root.to_string_lossy().into_owned(),
                        generation,
                        message,
                    },
                );
            }
        },
        NoCache::new(),
        NotifyConfig::default(),
    )
    .map_err(|error| error.to_string())?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    Ok(debouncer)
}

fn scoped_existing_path(state: &WorkspaceState, path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let root = active_workspace_root(state)?;
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if canonical != root && !canonical.starts_with(&root) {
        return Err("Path is outside the active workspace".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
fn set_workspace_root(
    path: String,
    app: tauri::AppHandle,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<WorkspaceBinding, String> {
    let state = workspace_for_window(&registry, &window)?;
    let root = open_workspace_root(Path::new(&path))?;
    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let watcher = create_workspace_watcher(
        app,
        window.label().to_string(),
        root.path.clone(),
        generation,
    )
    .ok();
    let binding =
        commit_workspace_candidate_for_label(&state, root, watcher, generation, window.label())?;
    Ok(binding)
}

#[tauri::command]
fn list_directory(
    path: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Vec<FsEntry>, String> {
    let state = workspace_for_window(&registry, &window)?;
    let directory_path = scoped_existing_path(&state, path)?;
    if !directory_path.is_dir() {
        return Err("The requested path is not a directory".to_string());
    }

    let mut entries = Vec::new();
    let directory = fs::read_dir(directory_path).map_err(|error| error.to_string())?;

    for item in directory {
        let item = item.map_err(|error| error.to_string())?;
        let item_path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        entries.push(entry_from_path(&item_path)?);
    }

    entries.sort_by(|left, right| {
        let left_folder = left.kind == "folder";
        let right_folder = right.kind == "folder";
        right_folder
            .cmp(&left_folder)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn inspect_path(path: String) -> Result<FsEntry, String> {
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    entry_from_path(&canonical)
}

fn version_for_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hash}:{}", bytes.len())
}

const MAX_MARKDOWN_FILENAME_UTF16_UNITS: usize = 255;
const MAX_DIRECTORY_NAME_UTF16_UNITS: usize = 255;

fn is_markdown_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{0085}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

fn normalize_markdown_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim_matches(is_markdown_trim_whitespace);
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.eq_ignore_ascii_case(".md")
        || trimmed
            .chars()
            .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err("INVALID_MARKDOWN_NAME".to_string());
    }

    let normalized = if trimmed.to_ascii_lowercase().ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    if normalized.encode_utf16().count() > MAX_MARKDOWN_FILENAME_UTF16_UNITS {
        return Err("MARKDOWN_NAME_TOO_LONG".to_string());
    }
    Ok(normalized)
}

fn is_internal_temporary_name(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.starts_with('.') && lowered.contains(".localview-") && lowered.ends_with(".tmp")
}

fn normalize_directory_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim_matches(is_markdown_trim_whitespace);
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed
            .chars()
            .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err("INVALID_DIRECTORY_NAME".to_string());
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered == ".ds_store" || is_internal_temporary_name(trimmed) {
        return Err("DIRECTORY_NAME_RESERVED".to_string());
    }
    if [".numbers", ".pages", ".key"]
        .iter()
        .any(|suffix| lowered.ends_with(suffix))
    {
        return Err("DIRECTORY_BUNDLE_NAME_UNSUPPORTED".to_string());
    }
    if trimmed.encode_utf16().count() > MAX_DIRECTORY_NAME_UTF16_UNITS {
        return Err("DIRECTORY_NAME_TOO_LONG".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct ScopedParentErrors<'a> {
    not_directory: &'a str,
    changed: &'a str,
    create_failed: &'a str,
}

#[cfg(unix)]
const MARKDOWN_PARENT_ERRORS: ScopedParentErrors<'static> = ScopedParentErrors {
    not_directory: "MARKDOWN_PARENT_NOT_DIRECTORY",
    changed: "MARKDOWN_PARENT_CHANGED",
    create_failed: "CREATE_MARKDOWN_FAILED",
};

#[cfg(unix)]
const DIRECTORY_PARENT_ERRORS: ScopedParentErrors<'static> = ScopedParentErrors {
    not_directory: "DIRECTORY_PARENT_NOT_DIRECTORY",
    changed: "DIRECTORY_PARENT_CHANGED",
    create_failed: "CREATE_DIRECTORY_FAILED",
};

#[cfg(unix)]
fn validate_directory_identity(
    path: &Path,
    directory: &OwnedFd,
    changed_error: &str,
) -> Result<(), String> {
    let handle_stat = unix_fs::fstat(directory).map_err(|_| changed_error.to_string())?;
    let path_stat = unix_fs::stat(path).map_err(|_| changed_error.to_string())?;
    if !FileType::from_raw_mode(handle_stat.st_mode).is_dir()
        || handle_stat.st_dev != path_stat.st_dev
        || handle_stat.st_ino != path_stat.st_ino
    {
        return Err(changed_error.to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn open_scoped_parent_directory_with_hook<F>(
    state: &WorkspaceState,
    parent_path: &Path,
    errors: ScopedParentErrors<'_>,
    after_parent_canonicalized: F,
) -> Result<(PathBuf, OwnedFd), String>
where
    F: FnOnce(),
{
    let root = active_workspace_capability(state)?;
    validate_directory_identity(&root.path, &root.directory, "WORKSPACE_ROOT_CHANGED")?;

    let parent = fs::canonicalize(parent_path).map_err(|error| error.to_string())?;
    if parent != root.path && !parent.starts_with(&root.path) {
        return Err("Path is outside the active workspace".to_string());
    }
    let metadata = fs::metadata(&parent).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_document_bundle(&parent, true) {
        return Err(errors.not_directory.to_string());
    }
    let relative = parent
        .strip_prefix(&root.path)
        .map_err(|_| "Path is outside the active workspace".to_string())?;

    after_parent_canonicalized();

    let mut directory = root.directory;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(errors.changed.to_string());
        };
        directory = unix_fs::openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            if matches!(error, Errno::NOENT | Errno::NOTDIR | Errno::LOOP) {
                errors.changed.to_string()
            } else {
                format!("{}: {error}", errors.create_failed)
            }
        })?;
    }
    validate_directory_identity(&parent, &directory, errors.changed)?;
    Ok((parent, directory))
}

fn create_markdown_file_with_hooks<F, G>(
    state: &WorkspaceState,
    parent_path: &Path,
    name: &str,
    after_parent_canonicalized: F,
    before_final_create: G,
) -> Result<CreatedTextFile, String>
where
    F: FnOnce(),
    G: FnOnce(),
{
    let name = normalize_markdown_file_name(name)?;

    #[cfg(not(unix))]
    {
        let _ = (
            state,
            parent_path,
            after_parent_canonicalized,
            before_final_create,
        );
        return Err("CREATE_MARKDOWN_UNSUPPORTED".to_string());
    }

    #[cfg(unix)]
    {
        let (parent, directory) = open_scoped_parent_directory_with_hook(
            state,
            parent_path,
            MARKDOWN_PARENT_ERRORS,
            after_parent_canonicalized,
        )?;
        before_final_create();
        validate_directory_identity(&parent, &directory, "MARKDOWN_PARENT_CHANGED")?;

        let mode = Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::WGRP | Mode::ROTH | Mode::WOTH;
        let file = unix_fs::openat(
            &directory,
            name.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            mode,
        )
        .map_err(|error| match error {
            Errno::EXIST => "MARKDOWN_FILE_EXISTS".to_string(),
            Errno::NAMETOOLONG => "MARKDOWN_NAME_TOO_LONG".to_string(),
            _ => format!("CREATE_MARKDOWN_FAILED: {error}"),
        })?;
        drop(file);

        let path = parent.join(&name);
        Ok(CreatedTextFile {
            entry: FsEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: "md".to_string(),
            },
            snapshot: TextFileSnapshot {
                content: String::new(),
                version: version_for_bytes(b""),
            },
        })
    }
}

fn create_markdown_file_impl(
    state: &WorkspaceState,
    parent_path: &Path,
    name: &str,
) -> Result<CreatedTextFile, String> {
    create_markdown_file_with_hooks(state, parent_path, name, || {}, || {})
}

#[tauri::command]
fn create_markdown_file(
    parent_path: String,
    name: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<CreatedTextFile, String> {
    let state = workspace_for_window(&registry, &window)?;
    create_markdown_file_impl(&state, Path::new(&parent_path), &name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirectoryCreateHookPhase {
    BeforeFinalCreate,
    AfterCreate,
}

fn create_directory_with_hooks<F, G>(
    state: &WorkspaceState,
    parent_path: &Path,
    name: &str,
    after_parent_canonicalized: F,
    mutation_hook: G,
) -> Result<FsEntry, String>
where
    F: FnOnce(),
    G: Fn(DirectoryCreateHookPhase),
{
    let name = normalize_directory_name(name)?;

    #[cfg(not(unix))]
    {
        let _ = (
            state,
            parent_path,
            after_parent_canonicalized,
            mutation_hook,
        );
        return Err("CREATE_DIRECTORY_UNSUPPORTED".to_string());
    }

    #[cfg(unix)]
    {
        let (parent, directory) = open_scoped_parent_directory_with_hook(
            state,
            parent_path,
            DIRECTORY_PARENT_ERRORS,
            after_parent_canonicalized,
        )?;
        mutation_hook(DirectoryCreateHookPhase::BeforeFinalCreate);
        validate_directory_identity(&parent, &directory, "DIRECTORY_PARENT_CHANGED")?;

        let mode = Mode::RWXU | Mode::RWXG | Mode::RWXO;
        unix_fs::mkdirat(&directory, name.as_str(), mode).map_err(|error| match error {
            Errno::EXIST => "DIRECTORY_ENTRY_EXISTS".to_string(),
            Errno::NAMETOOLONG => "DIRECTORY_NAME_TOO_LONG".to_string(),
            _ => format!("CREATE_DIRECTORY_FAILED: {error}"),
        })?;

        let path = parent.join(&name);
        let created_directory = unix_fs::openat(
            &directory,
            name.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| "CREATE_DIRECTORY_RESULT_UNCERTAIN".to_string())?;
        mutation_hook(DirectoryCreateHookPhase::AfterCreate);
        validate_directory_identity(&parent, &directory, "CREATE_DIRECTORY_RESULT_UNCERTAIN")?;
        validate_directory_identity(
            &path,
            &created_directory,
            "CREATE_DIRECTORY_RESULT_UNCERTAIN",
        )?;

        Ok(FsEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            kind: "folder".to_string(),
        })
    }
}

fn create_directory_impl(
    state: &WorkspaceState,
    parent_path: &Path,
    name: &str,
) -> Result<FsEntry, String> {
    create_directory_with_hooks(state, parent_path, name, || {}, |_| {})
}

#[tauri::command]
fn create_directory(
    parent_path: String,
    name: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<FsEntry, String> {
    let state = workspace_for_window(&registry, &window)?;
    create_directory_impl(&state, Path::new(&parent_path), &name)
}

#[cfg(unix)]
struct ScopedFile {
    path: PathBuf,
    parent_path: PathBuf,
    parent: OwnedFd,
    name: std::ffi::OsString,
    file: OwnedFd,
    identity: FileIdentity,
    mode: u16,
}

#[cfg(unix)]
fn command_errno(error: Errno) -> CommandError {
    let code = match error {
        Errno::NOENT | Errno::NOTDIR => "FILE_NOT_FOUND",
        Errno::ACCESS | Errno::PERM => "PERMISSION_DENIED",
        _ => "IO_ERROR",
    };
    CommandError::new(code, error.to_string())
}

#[cfg(unix)]
fn open_scoped_file(state: &WorkspaceState, requested: &Path) -> Result<ScopedFile, CommandError> {
    let root = active_workspace_capability(state).map_err(CommandError::legacy)?;
    validate_directory_identity(&root.path, &root.directory, "WORKSPACE_ROOT_CHANGED")
        .map_err(CommandError::legacy)?;
    let path = fs::canonicalize(requested).map_err(CommandError::io)?;
    if path == root.path || !path.starts_with(&root.path) {
        return Err(CommandError::new(
            "WORKSPACE_CHANGED",
            "Path is outside the active workspace",
        ));
    }
    let parent_path = path
        .parent()
        .ok_or_else(|| CommandError::new("FILE_NOT_FOUND", "The file has no parent directory"))?
        .to_path_buf();
    let relative = parent_path.strip_prefix(&root.path).map_err(|_| {
        CommandError::new("WORKSPACE_CHANGED", "Path is outside the active workspace")
    })?;
    let mut parent = root.directory;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(CommandError::new(
                "WORKSPACE_CHANGED",
                "Invalid file parent path",
            ));
        };
        parent = unix_fs::openat(
            &parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(command_errno)?;
    }
    validate_directory_identity(&parent_path, &parent, "WORKSPACE_ROOT_CHANGED")
        .map_err(CommandError::legacy)?;
    let name = path
        .file_name()
        .ok_or_else(|| CommandError::new("FILE_NOT_FOUND", "The file has no name"))?
        .to_os_string();
    let file = unix_fs::openat(
        &parent,
        &name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(command_errno)?;
    let stat = unix_fs::fstat(&file).map_err(command_errno)?;
    if !FileType::from_raw_mode(stat.st_mode).is_file() {
        return Err(CommandError::new(
            "FILE_NOT_FOUND",
            "The requested path is not a file",
        ));
    }
    let path_stat = unix_fs::stat(&path).map_err(command_errno)?;
    let identity = FileIdentity {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
    };
    if identity
        != (FileIdentity {
            device: path_stat.st_dev as u64,
            inode: path_stat.st_ino as u64,
        })
    {
        return Err(CommandError::new(
            "WORKSPACE_CHANGED",
            "The file changed while it was being opened",
        ));
    }
    Ok(ScopedFile {
        path,
        parent_path,
        parent,
        name,
        file,
        identity,
        mode: stat.st_mode as u16,
    })
}

fn read_text_file_impl(
    state: &WorkspaceState,
    path: &Path,
) -> Result<TextFileSnapshot, CommandError> {
    #[cfg(unix)]
    {
        let scoped = open_scoped_file(state, path)?;
        let mut file = std::fs::File::from(scoped.file);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(CommandError::io)?;
        let version = version_for_bytes(&bytes);
        let content = String::from_utf8(bytes)
            .map_err(|_| CommandError::new("INVALID_UTF8", "The file is not valid UTF-8"))?;
        return Ok(TextFileSnapshot { content, version });
    }

    #[cfg(not(unix))]
    {
        let path = scoped_existing_path(state, path).map_err(CommandError::legacy)?;
        if !path.is_file() {
            return Err(CommandError::new(
                "FILE_NOT_FOUND",
                "The requested path is not a file",
            ));
        }
        let bytes = fs::read(path).map_err(CommandError::io)?;
        let version = version_for_bytes(&bytes);
        let content = String::from_utf8(bytes)
            .map_err(|_| CommandError::new("INVALID_UTF8", "The file is not valid UTF-8"))?;
        Ok(TextFileSnapshot { content, version })
    }
}

#[tauri::command]
fn read_text_file(
    path: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<TextFileSnapshot, CommandError> {
    let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
    read_text_file_impl(&state, Path::new(&path))
}

#[cfg(not(unix))]
fn create_temp_file(path: &Path, content: &[u8]) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The file has no parent directory".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let permissions = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions();

    for attempt in 0..100_u8 {
        let temp_path = parent.join(format!(
            ".{name}.localview-{}-{attempt}.tmp",
            std::process::id()
        ));
        let mut file = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };

        let result = (|| -> Result<(), String> {
            file.write_all(content).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            fs::set_permissions(&temp_path, permissions.clone())
                .map_err(|error| error.to_string())?;
            Ok(())
        })();

        if let Err(error) = result {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
        return Ok(temp_path);
    }

    Err("Could not create a temporary file for atomic save".to_string())
}

#[cfg(unix)]
fn write_text_file_with_hook<F>(
    state: &WorkspaceState,
    path: &Path,
    content: &str,
    expected_version: &str,
    before_commit: F,
) -> Result<String, CommandError>
where
    F: FnOnce(),
{
    let scoped = open_scoped_file(state, path)?;
    let ScopedFile {
        path: scoped_path,
        parent_path,
        parent,
        name,
        file,
        identity,
        mode,
    } = scoped;
    let mut current_file = std::fs::File::from(file);
    let mut current = Vec::new();
    current_file
        .read_to_end(&mut current)
        .map_err(CommandError::io)?;
    if version_for_bytes(&current) != expected_version {
        return Err(CommandError::new(
            "EXTERNAL_CHANGE",
            "The file changed on disk",
        ));
    }
    let bytes = content.as_bytes();
    let mut before_commit = Some(before_commit);
    for attempt in 0..100_u8 {
        let temp_name =
            std::ffi::OsString::from(format!(".localview-{}-{attempt}.tmp", std::process::id()));
        let temp = match unix_fs::openat(
            &parent,
            &temp_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(mode & 0o7777),
        ) {
            Ok(file) => file,
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(command_errno(error)),
        };
        unix_fs::fchmod(&temp, Mode::from_raw_mode(mode & 0o7777)).map_err(command_errno)?;
        let mut temp_file = std::fs::File::from(temp);
        if let Err(error) = temp_file
            .write_all(bytes)
            .and_then(|_| temp_file.sync_all())
        {
            drop(temp_file);
            let _ = unix_fs::unlinkat(&parent, &temp_name, unix_fs::AtFlags::empty());
            return Err(CommandError::io(error));
        }
        drop(temp_file);
        if let Some(hook) = before_commit.take() {
            hook();
        }
        let result = (|| -> Result<String, CommandError> {
            validate_directory_identity(&parent_path, &parent, "WORKSPACE_ROOT_CHANGED")
                .map_err(CommandError::legacy)?;
            let latest = unix_fs::openat(
                &parent,
                &name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(command_errno)?;
            let latest_stat = unix_fs::fstat(&latest).map_err(command_errno)?;
            let latest_identity = FileIdentity {
                device: latest_stat.st_dev as u64,
                inode: latest_stat.st_ino as u64,
            };
            let mut latest_file = std::fs::File::from(latest);
            let mut latest_bytes = Vec::new();
            latest_file
                .read_to_end(&mut latest_bytes)
                .map_err(CommandError::io)?;
            if latest_identity != identity || version_for_bytes(&latest_bytes) != expected_version {
                return Err(CommandError::new(
                    "EXTERNAL_CHANGE",
                    "The file changed on disk",
                ));
            }
            unix_fs::renameat(&parent, &temp_name, &parent, &name).map_err(command_errno)?;
            let path_after = fs::canonicalize(&scoped_path).map_err(CommandError::io)?;
            if path_after != scoped_path {
                return Err(CommandError::new(
                    "WORKSPACE_CHANGED",
                    "The saved file resolved to an unexpected path",
                ));
            }
            Ok(version_for_bytes(bytes))
        })();
        if result.is_err() {
            let _ = unix_fs::unlinkat(&parent, &temp_name, unix_fs::AtFlags::empty());
        }
        return result;
    }
    Err(CommandError::new(
        "IO_ERROR",
        "Could not create a temporary file for atomic save",
    ))
}

fn write_text_file_impl(
    state: &WorkspaceState,
    path: &Path,
    content: &str,
    expected_version: &str,
) -> Result<String, CommandError> {
    #[cfg(unix)]
    {
        return write_text_file_with_hook(state, path, content, expected_version, || {});
    }

    #[cfg(not(unix))]
    {
        let path = scoped_existing_path(state, path).map_err(CommandError::legacy)?;
        if !path.is_file() {
            return Err(CommandError::new(
                "FILE_NOT_FOUND",
                "The requested path is not a file",
            ));
        }

        let current = fs::read(&path).map_err(CommandError::io)?;
        if version_for_bytes(&current) != expected_version {
            return Err(CommandError::new(
                "EXTERNAL_CHANGE",
                "The file changed on disk",
            ));
        }

        let bytes = content.as_bytes();
        let temp_path = create_temp_file(&path, bytes).map_err(CommandError::legacy)?;

        let latest = fs::read(&path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            CommandError::io(error)
        })?;
        if version_for_bytes(&latest) != expected_version {
            let _ = fs::remove_file(&temp_path);
            return Err(CommandError::new(
                "EXTERNAL_CHANGE",
                "The file changed on disk",
            ));
        }

        if let Err(error) = fs::rename(&temp_path, &path) {
            let _ = fs::remove_file(&temp_path);
            return Err(CommandError::io(error));
        }

        Ok(version_for_bytes(bytes))
    }
}

#[tauri::command]
fn write_text_file(
    path: String,
    content: String,
    expected_version: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, CommandError> {
    let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
    write_text_file_impl(&state, Path::new(&path), &content, &expected_version)
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct TrashPreflight {
    original: PathBuf,
    parent: PathBuf,
    root: PathBuf,
    root_identity: FileIdentity,
    parent_identity: FileIdentity,
    target_identity: FileIdentity,
    is_dir: bool,
    workspace_generation: u64,
}

#[cfg(unix)]
fn identity_token(identity: FileIdentity) -> String {
    format!("{}:{}", identity.device, identity.inode)
}

#[cfg(unix)]
fn trash_preflight(state: &WorkspaceState, requested: &Path) -> Result<TrashPreflight, String> {
    let (root, workspace_generation) = active_workspace_capability_with_generation(state)?;
    validate_directory_identity(&root.path, &root.directory, "WORKSPACE_ROOT_CHANGED")?;
    let raw_metadata =
        fs::symlink_metadata(requested).map_err(|error| format!("TRASH_FAILED: {error}"))?;
    if raw_metadata.file_type().is_symlink() {
        return Err("TRASH_SYMLINK_UNSUPPORTED".to_string());
    }
    let original = fs::canonicalize(requested).map_err(|error| format!("TRASH_FAILED: {error}"))?;
    if original == root.path {
        return Err("TRASH_ROOT_FORBIDDEN".to_string());
    }
    if !original.starts_with(&root.path) {
        return Err("Path is outside the active workspace".to_string());
    }
    let parent = original
        .parent()
        .ok_or_else(|| "TRASH_TARGET_CHANGED".to_string())?
        .to_path_buf();
    let canonical_parent =
        fs::canonicalize(&parent).map_err(|_| "TRASH_TARGET_CHANGED".to_string())?;
    if canonical_parent != root.path && !canonical_parent.starts_with(&root.path) {
        return Err("Path is outside the active workspace".to_string());
    }
    let root_metadata =
        fs::metadata(&root.path).map_err(|_| "WORKSPACE_ROOT_CHANGED".to_string())?;
    let parent_metadata =
        fs::metadata(&canonical_parent).map_err(|_| "TRASH_TARGET_CHANGED".to_string())?;
    let target_metadata =
        fs::metadata(&original).map_err(|_| "TRASH_TARGET_CHANGED".to_string())?;
    let root_identity = metadata_identity(&root_metadata);
    if root_identity
        != (FileIdentity {
            device: root.device,
            inode: root.inode,
        })
    {
        return Err("WORKSPACE_ROOT_CHANGED".to_string());
    }
    Ok(TrashPreflight {
        original,
        parent: canonical_parent,
        root: root.path,
        root_identity,
        parent_identity: metadata_identity(&parent_metadata),
        target_identity: metadata_identity(&target_metadata),
        is_dir: target_metadata.is_dir(),
        workspace_generation,
    })
}

#[cfg(unix)]
fn trash_candidate(preflight: &TrashPreflight) -> TrashCandidate {
    TrashCandidate {
        original_path: preflight.original.to_string_lossy().into_owned(),
        workspace_generation: preflight.workspace_generation,
        parent_identity: identity_token(preflight.parent_identity),
        target_identity: identity_token(preflight.target_identity),
        is_dir: preflight.is_dir,
    }
}

#[cfg(unix)]
fn revalidate_trash_preflight(preflight: &TrashPreflight) -> Result<(), String> {
    let current = [
        (&preflight.root, preflight.root_identity),
        (&preflight.parent, preflight.parent_identity),
        (&preflight.original, preflight.target_identity),
    ];
    for (path, expected) in current {
        let metadata = fs::metadata(path).map_err(|_| "TRASH_TARGET_CHANGED".to_string())?;
        if metadata_identity(&metadata) != expected {
            return Err("TRASH_TARGET_CHANGED".to_string());
        }
    }
    let raw = fs::symlink_metadata(&preflight.original)
        .map_err(|_| "TRASH_TARGET_CHANGED".to_string())?;
    if raw.file_type().is_symlink() {
        return Err("TRASH_SYMLINK_UNSUPPORTED".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn trash_path_macos(path: &Path, is_dir: bool) -> Result<PathBuf, String> {
    autoreleasepool(|_| {
        let path_string = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath_isDirectory(&path_string, is_dir);
        let manager = NSFileManager::defaultManager();
        let mut resulting_url = None;
        manager
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting_url))
            .map_err(|error| format!("TRASH_FAILED: {}", error.localizedDescription()))?;
        let resulting_url = resulting_url.ok_or_else(|| "TRASH_RESULT_MISSING".to_string())?;
        let resulting_path = resulting_url
            .path()
            .ok_or_else(|| "TRASH_RESULT_MISSING".to_string())?;
        Ok(PathBuf::from(resulting_path.to_string()))
    })
}

#[cfg(test)]
fn move_to_trash_impl(state: &WorkspaceState, requested: &Path) -> Result<TrashedItem, String> {
    #[cfg(not(unix))]
    {
        let _ = (state, requested);
        return Err("TRASH_UNSUPPORTED".to_string());
    }

    #[cfg(unix)]
    {
        let preflight = trash_preflight(state, requested)?;
        move_candidate_to_trash_impl(state, &trash_candidate(&preflight))
    }
}

fn move_candidate_to_trash_impl(
    state: &WorkspaceState,
    candidate: &TrashCandidate,
) -> Result<TrashedItem, String> {
    #[cfg(not(unix))]
    {
        let _ = (state, candidate);
        return Err("TRASH_UNSUPPORTED".to_string());
    }

    #[cfg(unix)]
    {
        let preflight = trash_preflight(state, Path::new(&candidate.original_path))?;
        if preflight.workspace_generation != candidate.workspace_generation {
            return Err("WORKSPACE_CHANGED".to_string());
        }
        if identity_token(preflight.parent_identity) != candidate.parent_identity
            || identity_token(preflight.target_identity) != candidate.target_identity
            || preflight.is_dir != candidate.is_dir
        {
            return Err("TRASH_TARGET_CHANGED".to_string());
        }
        revalidate_trash_preflight(&preflight)?;

        #[cfg(target_os = "macos")]
        {
            let trashed_path = trash_path_macos(&preflight.original, preflight.is_dir)?;
            return Ok(TrashedItem {
                original_path: preflight.original.to_string_lossy().into_owned(),
                trashed_path: trashed_path.to_string_lossy().into_owned(),
            });
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = preflight;
            Err("TRASH_UNSUPPORTED".to_string())
        }
    }
}

#[tauri::command]
fn prepare_trash(
    path: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<TrashCandidate, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (path, window, registry);
        Err(CommandError::new("IO_ERROR", "TRASH_UNSUPPORTED"))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        let preflight = trash_preflight(&state, Path::new(&path)).map_err(CommandError::legacy)?;
        Ok(trash_candidate(&preflight))
    }
}

#[tauri::command]
fn move_to_trash(
    candidate: TrashCandidate,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<TrashedItem, CommandError> {
    let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
    move_candidate_to_trash_impl(&state, &candidate).map_err(CommandError::legacy)
}

#[cfg(unix)]
struct MoveDirectory {
    path: PathBuf,
    directory: OwnedFd,
    identity: FileIdentity,
}

#[cfg(unix)]
struct RelocationPreflight {
    root: WorkspaceRoot,
    source_path: PathBuf,
    destination_directory: PathBuf,
    destination_path: PathBuf,
    source_parent: MoveDirectory,
    destination_parent: MoveDirectory,
    source_name: std::ffi::OsString,
    destination_name: std::ffi::OsString,
    source_identity: FileIdentity,
    source_is_directory: bool,
    source_is_bundle: bool,
    workspace_generation: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct RelocationErrorCodes {
    source_changed: &'static str,
    destination_changed: &'static str,
    destination_exists: &'static str,
    bundle_boundary: &'static str,
    secure_unavailable: &'static str,
    outcome_uncertain: &'static str,
    cross_device: Option<&'static str>,
    strict_rollback_identity: bool,
}

#[cfg(unix)]
const MOVE_RELOCATION_ERRORS: RelocationErrorCodes = RelocationErrorCodes {
    source_changed: "MOVE_SOURCE_CHANGED",
    destination_changed: "MOVE_DESTINATION_CHANGED",
    destination_exists: "MOVE_DESTINATION_EXISTS",
    bundle_boundary: "MOVE_BUNDLE_BOUNDARY",
    secure_unavailable: "MOVE_SECURE_RENAME_UNAVAILABLE",
    outcome_uncertain: "MOVE_OUTCOME_UNCERTAIN",
    cross_device: Some("MOVE_CROSS_DEVICE_UNSUPPORTED"),
    strict_rollback_identity: false,
};

#[cfg(unix)]
const RENAME_RELOCATION_ERRORS: RelocationErrorCodes = RelocationErrorCodes {
    source_changed: "RENAME_SOURCE_CHANGED",
    destination_changed: "RENAME_PARENT_CHANGED",
    destination_exists: "RENAME_DESTINATION_EXISTS",
    bundle_boundary: "RENAME_BUNDLE_BOUNDARY",
    secure_unavailable: "RENAME_SECURE_UNAVAILABLE",
    outcome_uncertain: "RENAME_OUTCOME_UNCERTAIN",
    cross_device: None,
    strict_rollback_identity: true,
};

#[cfg(unix)]
fn move_directory_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError::new(code, message)
}

#[cfg(unix)]
fn open_move_directory(
    root: &WorkspaceRoot,
    requested: &Path,
    changed_code: &str,
    bundle_boundary_code: &str,
) -> Result<MoveDirectory, CommandError> {
    validate_directory_identity(&root.path, &root.directory, "WORKSPACE_ROOT_CHANGED")
        .map_err(CommandError::legacy)?;
    let relative = requested.strip_prefix(&root.path).map_err(|_| {
        move_directory_error("WORKSPACE_CHANGED", "Path is outside the active workspace")
    })?;
    let mut directory = fcntl_dupfd_cloexec(&root.directory, 0)
        .map_err(|error| move_directory_error("IO_ERROR", error.to_string()))?;
    let mut normalized = root.path.clone();
    if is_document_bundle(&normalized, true) {
        return Err(move_directory_error(
            bundle_boundary_code,
            "Items inside an iWork document bundle cannot be moved independently",
        ));
    }
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(move_directory_error(
                "WORKSPACE_CHANGED",
                "Workspace move path contains an invalid component",
            ));
        };
        directory = unix_fs::openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| match error {
            Errno::NOENT | Errno::NOTDIR | Errno::LOOP => {
                move_directory_error(changed_code, "The move directory changed")
            }
            Errno::ACCESS | Errno::PERM => {
                move_directory_error("PERMISSION_DENIED", error.to_string())
            }
            _ => move_directory_error("IO_ERROR", error.to_string()),
        })?;
        normalized.push(name);
        if is_document_bundle(&normalized, true) {
            return Err(move_directory_error(
                bundle_boundary_code,
                "Items cannot be moved into or out of an iWork document bundle",
            ));
        }
    }
    let stat = unix_fs::fstat(&directory)
        .map_err(|error| move_directory_error(changed_code, error.to_string()))?;
    if !FileType::from_raw_mode(stat.st_mode).is_dir() {
        return Err(move_directory_error(
            changed_code,
            "Move target is not a directory",
        ));
    }
    Ok(MoveDirectory {
        path: normalized,
        directory,
        identity: FileIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
        },
    })
}

#[cfg(unix)]
fn move_preflight(
    state: &WorkspaceState,
    requested_source: &Path,
    requested_destination: &Path,
) -> Result<RelocationPreflight, CommandError> {
    let (root, workspace_generation) =
        active_workspace_capability_with_generation(state).map_err(CommandError::legacy)?;
    if requested_source == root.path {
        return Err(move_directory_error(
            "MOVE_SOURCE_UNSUPPORTED",
            "The workspace root cannot be moved",
        ));
    }
    let source_parent_path = requested_source.parent().ok_or_else(|| {
        move_directory_error("MOVE_SOURCE_UNSUPPORTED", "The move source has no parent")
    })?;
    let source_parent = open_move_directory(
        &root,
        source_parent_path,
        "MOVE_SOURCE_CHANGED",
        MOVE_RELOCATION_ERRORS.bundle_boundary,
    )?;
    let destination_parent = open_move_directory(
        &root,
        requested_destination,
        "MOVE_DESTINATION_CHANGED",
        MOVE_RELOCATION_ERRORS.bundle_boundary,
    )?;
    if source_parent.identity == destination_parent.identity {
        return Err(move_directory_error(
            "MOVE_SAME_PARENT",
            "The file is already in that folder",
        ));
    }
    let source_name = requested_source.file_name().ok_or_else(|| {
        move_directory_error("MOVE_SOURCE_UNSUPPORTED", "The move source has no filename")
    })?;
    let source_path = source_parent.path.join(source_name);
    if source_path == root.path {
        return Err(move_directory_error(
            "MOVE_SOURCE_UNSUPPORTED",
            "The workspace root cannot be moved",
        ));
    }
    let source = unix_fs::openat(
        &source_parent.directory,
        source_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| match error {
        Errno::LOOP => {
            move_directory_error("MOVE_SOURCE_UNSUPPORTED", "Symbolic links cannot be moved")
        }
        Errno::NOENT | Errno::NOTDIR => {
            move_directory_error("MOVE_SOURCE_CHANGED", "The move source changed")
        }
        Errno::ACCESS | Errno::PERM => move_directory_error("PERMISSION_DENIED", error.to_string()),
        _ => move_directory_error("IO_ERROR", error.to_string()),
    })?;
    let source_stat = unix_fs::fstat(&source)
        .map_err(|error| move_directory_error("MOVE_SOURCE_CHANGED", error.to_string()))?;
    let source_type = FileType::from_raw_mode(source_stat.st_mode);
    let source_is_directory = source_type.is_dir();
    let source_is_bundle = source_is_directory && is_document_bundle(&source_path, true);
    if !source_type.is_file() && !source_is_directory {
        return Err(move_directory_error(
            "MOVE_SOURCE_UNSUPPORTED",
            "Only files and directories can be moved",
        ));
    }
    if source_is_directory
        && (destination_parent.path == source_path
            || destination_parent.path.starts_with(&source_path))
    {
        return Err(move_directory_error(
            "MOVE_DESTINATION_INSIDE_SOURCE",
            "A directory cannot be moved into itself or one of its descendants",
        ));
    }
    let source_identity = FileIdentity {
        device: source_stat.st_dev as u64,
        inode: source_stat.st_ino as u64,
    };
    if source_identity.device != destination_parent.identity.device {
        return Err(move_directory_error(
            "MOVE_CROSS_DEVICE_UNSUPPORTED",
            "Cross-device moves are not supported",
        ));
    }
    match unix_fs::statat(
        &destination_parent.directory,
        source_name,
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Ok(_) => {
            return Err(move_directory_error(
                "MOVE_DESTINATION_EXISTS",
                "An item with the same name already exists in the destination",
            ));
        }
        Err(Errno::NOENT) => {}
        Err(error) => {
            return Err(move_directory_error(
                "MOVE_DESTINATION_CHANGED",
                error.to_string(),
            ));
        }
    }
    let destination_path = destination_parent.path.join(source_name);
    Ok(RelocationPreflight {
        root,
        source_path,
        destination_directory: destination_parent.path.clone(),
        destination_path,
        source_parent,
        destination_parent,
        source_name: source_name.to_os_string(),
        destination_name: source_name.to_os_string(),
        source_identity,
        source_is_directory,
        source_is_bundle,
        workspace_generation,
    })
}

#[cfg(unix)]
fn is_rename_trim_whitespace(character: char) -> bool {
    matches!(
        character as u32,
        0x0009..=0x000d
            | 0x0020
            | 0x0085
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
    )
}

#[cfg(unix)]
fn rename_locked_suffix(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 && index < name.len() - 1 => &name[index..],
        _ => "",
    }
}

#[cfg(unix)]
fn rename_name_has_extension(name: &str) -> bool {
    matches!(name.rfind('.'), Some(index) if index > 0 && index < name.len() - 1)
}

#[cfg(unix)]
fn validate_workspace_rename_name(
    original_name: &str,
    requested_name: &str,
    source_is_directory: bool,
    source_is_bundle: bool,
) -> Result<String, CommandError> {
    let name = requested_name
        .trim_matches(is_rename_trim_whitespace)
        .to_string();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|character| {
            let code = character as u32;
            character == '/'
                || character == '\\'
                || code <= 0x001f
                || (0x007f..=0x009f).contains(&code)
        })
    {
        return Err(move_directory_error(
            "RENAME_INVALID_NAME",
            "The requested name is invalid",
        ));
    }
    let lowered = name.to_lowercase();
    let internal_temporary =
        lowered.starts_with('.') && lowered.contains(".localview-") && lowered.ends_with(".tmp");
    if lowered == ".ds_store" || internal_temporary {
        return Err(move_directory_error(
            "RENAME_RESERVED_NAME",
            "The requested name is reserved",
        ));
    }
    if source_is_directory
        && !source_is_bundle
        && [".numbers", ".pages", ".key"]
            .iter()
            .any(|suffix| lowered.ends_with(suffix))
    {
        return Err(move_directory_error(
            "RENAME_RESERVED_NAME",
            "Ordinary folders cannot use an iWork bundle suffix",
        ));
    }
    if !source_is_directory || source_is_bundle {
        let original_suffix = rename_locked_suffix(original_name);
        if original_suffix.is_empty() {
            if rename_name_has_extension(&name) {
                return Err(move_directory_error(
                    "RENAME_EXTENSION_CHANGE_UNSUPPORTED",
                    "Changing a file extension is not supported",
                ));
            }
        } else if rename_locked_suffix(&name) != original_suffix {
            return Err(move_directory_error(
                "RENAME_EXTENSION_CHANGE_UNSUPPORTED",
                "Changing a file extension is not supported",
            ));
        }
    }
    if name.encode_utf16().count() > 255 {
        return Err(move_directory_error(
            "RENAME_NAME_TOO_LONG",
            "The requested name is too long",
        ));
    }
    if name == original_name {
        return Err(move_directory_error(
            "RENAME_UNCHANGED",
            "The requested name is unchanged",
        ));
    }
    if lowered == original_name.to_lowercase() {
        return Err(move_directory_error(
            "RENAME_CASE_ONLY_UNSUPPORTED",
            "Case-only rename is not supported",
        ));
    }
    Ok(name)
}

#[cfg(unix)]
fn rename_preflight(
    state: &WorkspaceState,
    requested_source: &Path,
    requested_name: &str,
) -> Result<RelocationPreflight, CommandError> {
    let (root, workspace_generation) =
        active_workspace_capability_with_generation(state).map_err(CommandError::legacy)?;
    if requested_source == root.path {
        return Err(move_directory_error(
            "RENAME_ROOT_FORBIDDEN",
            "The workspace root cannot be renamed",
        ));
    }
    let source_parent_path = requested_source.parent().ok_or_else(|| {
        move_directory_error(
            "RENAME_SOURCE_UNSUPPORTED",
            "The rename source has no parent",
        )
    })?;
    let source_parent = open_move_directory(
        &root,
        source_parent_path,
        RENAME_RELOCATION_ERRORS.source_changed,
        RENAME_RELOCATION_ERRORS.bundle_boundary,
    )?;
    let destination_parent = open_move_directory(
        &root,
        source_parent_path,
        RENAME_RELOCATION_ERRORS.destination_changed,
        RENAME_RELOCATION_ERRORS.bundle_boundary,
    )?;
    if source_parent.identity != destination_parent.identity {
        return Err(move_directory_error(
            "RENAME_PARENT_CHANGED",
            "The rename parent changed",
        ));
    }
    let source_name = requested_source.file_name().ok_or_else(|| {
        move_directory_error(
            "RENAME_SOURCE_UNSUPPORTED",
            "The rename source has no filename",
        )
    })?;
    let Some(source_name_string) = source_name.to_str() else {
        return Err(move_directory_error(
            "RENAME_SOURCE_UNSUPPORTED",
            "Names that are not valid UTF-8 cannot be renamed",
        ));
    };
    let source_path = source_parent.path.join(source_name);
    if source_path == root.path {
        return Err(move_directory_error(
            "RENAME_ROOT_FORBIDDEN",
            "The workspace root cannot be renamed",
        ));
    }
    let source = unix_fs::openat(
        &source_parent.directory,
        source_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| match error {
        Errno::LOOP => move_directory_error(
            "RENAME_SOURCE_UNSUPPORTED",
            "Symbolic links cannot be renamed",
        ),
        Errno::NOENT | Errno::NOTDIR => {
            move_directory_error("RENAME_SOURCE_CHANGED", "The rename source changed")
        }
        Errno::ACCESS | Errno::PERM => move_directory_error("PERMISSION_DENIED", error.to_string()),
        _ => move_directory_error("IO_ERROR", error.to_string()),
    })?;
    let source_stat = unix_fs::fstat(&source)
        .map_err(|error| move_directory_error("RENAME_SOURCE_CHANGED", error.to_string()))?;
    let source_type = FileType::from_raw_mode(source_stat.st_mode);
    let source_is_directory = source_type.is_dir();
    let source_is_bundle = source_is_directory && is_document_bundle(&source_path, true);
    if !source_type.is_file() && !source_is_directory {
        return Err(move_directory_error(
            "RENAME_SOURCE_UNSUPPORTED",
            "Only files and directories can be renamed",
        ));
    }
    let destination_name = validate_workspace_rename_name(
        source_name_string,
        requested_name,
        source_is_directory,
        source_is_bundle,
    )?;
    match unix_fs::statat(
        &destination_parent.directory,
        destination_name.as_str(),
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Ok(_) => {
            return Err(move_directory_error(
                "RENAME_DESTINATION_EXISTS",
                "An item with the same name already exists",
            ));
        }
        Err(Errno::NOENT) => {}
        Err(error) => {
            return Err(move_directory_error(
                "RENAME_PARENT_CHANGED",
                error.to_string(),
            ));
        }
    }
    let source_identity = FileIdentity {
        device: source_stat.st_dev as u64,
        inode: source_stat.st_ino as u64,
    };
    let destination_path = destination_parent.path.join(&destination_name);
    Ok(RelocationPreflight {
        root,
        source_path,
        destination_directory: destination_parent.path.clone(),
        destination_path,
        source_parent,
        destination_parent,
        source_name: source_name.to_os_string(),
        destination_name: destination_name.into(),
        source_identity,
        source_is_directory,
        source_is_bundle,
        workspace_generation,
    })
}

#[cfg(unix)]
fn candidate_from_rename_preflight(preflight: &RelocationPreflight) -> RenameCandidate {
    RenameCandidate {
        source_path: preflight.source_path.to_string_lossy().into_owned(),
        destination_path: preflight.destination_path.to_string_lossy().into_owned(),
        workspace_generation: preflight.workspace_generation,
        parent_identity: identity_token(preflight.source_parent.identity),
        source_identity: identity_token(preflight.source_identity),
        source_is_directory: preflight.source_is_directory,
        source_is_bundle: preflight.source_is_bundle,
    }
}

#[cfg(unix)]
fn prepare_workspace_rename_impl(
    state: &WorkspaceState,
    source_path: &Path,
    new_name: &str,
) -> Result<RenameCandidate, CommandError> {
    rename_preflight(state, source_path, new_name)
        .map(|preflight| candidate_from_rename_preflight(&preflight))
}

#[cfg(unix)]
fn renamed_entry(candidate: &RenameCandidate) -> Result<FsEntry, CommandError> {
    let path = Path::new(&candidate.destination_path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            move_directory_error("RENAME_PARENT_CHANGED", "Invalid rename destination")
        })?;
    Ok(FsEntry {
        name: name.to_string(),
        path: candidate.destination_path.clone(),
        kind: file_kind(path, candidate.source_is_directory),
    })
}

#[cfg(unix)]
fn candidate_from_move_preflight(preflight: &RelocationPreflight) -> MoveCandidate {
    MoveCandidate {
        source_path: preflight.source_path.to_string_lossy().into_owned(),
        destination_directory: preflight
            .destination_directory
            .to_string_lossy()
            .into_owned(),
        destination_path: preflight.destination_path.to_string_lossy().into_owned(),
        workspace_generation: preflight.workspace_generation,
        source_parent_identity: identity_token(preflight.source_parent.identity),
        source_identity: identity_token(preflight.source_identity),
        destination_identity: identity_token(preflight.destination_parent.identity),
        source_is_directory: preflight.source_is_directory,
        source_is_bundle: preflight.source_is_bundle,
    }
}

#[cfg(unix)]
fn moved_entry(candidate: &MoveCandidate) -> Result<FsEntry, CommandError> {
    let path = Path::new(&candidate.destination_path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| move_directory_error("MOVE_DESTINATION_CHANGED", "Invalid destination"))?;
    Ok(FsEntry {
        name: name.to_string(),
        path: candidate.destination_path.clone(),
        kind: file_kind(path, candidate.source_is_directory),
    })
}

#[cfg(unix)]
fn prepare_workspace_move_impl(
    state: &WorkspaceState,
    source_path: &Path,
    destination_directory: &Path,
) -> Result<MoveCandidate, CommandError> {
    move_preflight(state, source_path, destination_directory)
        .map(|preflight| candidate_from_move_preflight(&preflight))
}

#[cfg(unix)]
fn root_relative_move_path(
    root: &Path,
    path: &Path,
    error_code: &str,
) -> Result<PathBuf, CommandError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        move_directory_error(error_code, "The move path is outside the workspace root")
    })?;
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(move_directory_error(
                error_code,
                "The move path contains an invalid component",
            ));
        };
        normalized.push(name);
    }
    if normalized.as_os_str().is_empty() {
        return Err(move_directory_error(
            error_code,
            "The workspace root cannot be moved",
        ));
    }
    Ok(normalized)
}

#[cfg(target_os = "macos")]
fn secure_workspace_rename(
    root: &WorkspaceRoot,
    source: &Path,
    destination: &Path,
    codes: RelocationErrorCodes,
) -> Result<(), CommandError> {
    const RENAME_NOFOLLOW_ANY_BITS: u32 = 0x0000_0010;
    const RENAME_RESOLVE_BENEATH_BITS: u32 = 0x0000_0020;
    let no_follow = RenameFlags::from_bits_retain(RENAME_NOFOLLOW_ANY_BITS);
    let beneath = RenameFlags::from_bits_retain(RENAME_RESOLVE_BENEATH_BITS);
    let preferred = RenameFlags::NOREPLACE | no_follow | beneath;
    match unix_fs::renameat_with(
        &root.directory,
        source,
        &root.directory,
        destination,
        preferred,
    ) {
        Ok(()) => Ok(()),
        Err(Errno::INVAL) => unix_fs::renameat_with(
            &root.directory,
            source,
            &root.directory,
            destination,
            RenameFlags::NOREPLACE | no_follow,
        )
        .map_err(|error| relocation_rename_error(error, codes)),
        Err(Errno::NOTSUP | Errno::OPNOTSUPP) => Err(move_directory_error(
            codes.secure_unavailable,
            "This volume does not support secure workspace relocation",
        )),
        Err(error) => Err(relocation_rename_error(error, codes)),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn secure_workspace_rename(
    _root: &WorkspaceRoot,
    _source: &Path,
    _destination: &Path,
    codes: RelocationErrorCodes,
) -> Result<(), CommandError> {
    Err(move_directory_error(
        codes.secure_unavailable,
        "Secure workspace relocation is unavailable on this platform",
    ))
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MoveCommitPhase {
    AfterFinalPreflight,
    AfterRename,
    BeforeRollback,
}

#[cfg(unix)]
trait MoveCommitObserver {
    fn on_phase(&mut self, _phase: MoveCommitPhase) {}
}

#[cfg(unix)]
struct NoopMoveCommitObserver;

#[cfg(unix)]
impl MoveCommitObserver for NoopMoveCommitObserver {}

#[cfg(all(unix, test))]
struct TestMoveCommitObserver<F>(F)
where
    F: FnMut(MoveCommitPhase);

#[cfg(all(unix, test))]
impl<F> MoveCommitObserver for TestMoveCommitObserver<F>
where
    F: FnMut(MoveCommitPhase),
{
    fn on_phase(&mut self, phase: MoveCommitPhase) {
        (self.0)(phase);
    }
}

#[cfg(unix)]
fn validate_final_relocation_preflight(
    preflight: &RelocationPreflight,
    codes: RelocationErrorCodes,
) -> Result<(), CommandError> {
    validate_directory_identity(
        &preflight.root.path,
        &preflight.root.directory,
        "WORKSPACE_ROOT_CHANGED",
    )
    .map_err(CommandError::legacy)?;
    let source_parent = open_move_directory(
        &preflight.root,
        &preflight.source_parent.path,
        codes.source_changed,
        codes.bundle_boundary,
    )?;
    if source_parent.identity != preflight.source_parent.identity
        || identity_at(&source_parent.directory, &preflight.source_name)
            .map_err(|_| move_directory_error(codes.source_changed, "The source changed"))?
            != Some(preflight.source_identity)
    {
        return Err(move_directory_error(
            codes.source_changed,
            "The source changed before commit",
        ));
    }
    let destination = open_move_directory(
        &preflight.root,
        &preflight.destination_parent.path,
        codes.destination_changed,
        codes.bundle_boundary,
    )?;
    if destination.identity != preflight.destination_parent.identity {
        return Err(move_directory_error(
            codes.destination_changed,
            "The destination parent changed before commit",
        ));
    }
    if identity_at(&destination.directory, &preflight.destination_name)
        .map_err(|_| move_directory_error(codes.destination_changed, "The destination changed"))?
        .is_some()
    {
        return Err(move_directory_error(
            codes.destination_exists,
            "An item with the same name already exists in the destination",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn observe_relocation_paths(
    preflight: &RelocationPreflight,
    codes: RelocationErrorCodes,
) -> Result<
    (
        MoveDirectory,
        MoveDirectory,
        Option<FileIdentity>,
        Option<FileIdentity>,
    ),
    CommandError,
> {
    validate_directory_identity(
        &preflight.root.path,
        &preflight.root.directory,
        "WORKSPACE_ROOT_CHANGED",
    )
    .map_err(CommandError::legacy)?;
    let source_parent = open_move_directory(
        &preflight.root,
        &preflight.source_parent.path,
        codes.source_changed,
        codes.bundle_boundary,
    )?;
    let destination = open_move_directory(
        &preflight.root,
        &preflight.destination_parent.path,
        codes.destination_changed,
        codes.bundle_boundary,
    )?;
    let source = identity_at(&source_parent.directory, &preflight.source_name)
        .map_err(|_| move_directory_error(codes.source_changed, "Unable to inspect source"))?;
    let moved = identity_at(&destination.directory, &preflight.destination_name).map_err(|_| {
        move_directory_error(codes.destination_changed, "Unable to inspect destination")
    })?;
    Ok((source_parent, destination, source, moved))
}

#[cfg(unix)]
fn commit_relocation_with_observer<O: MoveCommitObserver>(
    preflight: &RelocationPreflight,
    codes: RelocationErrorCodes,
    observer: &mut O,
) -> Result<(), CommandError> {
    let source_relative = root_relative_move_path(
        &preflight.root.path,
        &preflight.source_path,
        codes.source_changed,
    )?;
    let destination_relative = root_relative_move_path(
        &preflight.root.path,
        &preflight.destination_path,
        codes.destination_changed,
    )?;
    validate_final_relocation_preflight(preflight, codes)?;
    observer.on_phase(MoveCommitPhase::AfterFinalPreflight);
    secure_workspace_rename(
        &preflight.root,
        &source_relative,
        &destination_relative,
        codes,
    )?;
    observer.on_phase(MoveCommitPhase::AfterRename);

    let observation = observe_relocation_paths(preflight, codes);
    if let Ok((source_parent, destination_parent, source, destination)) = &observation {
        if source_parent.identity == preflight.source_parent.identity
            && destination_parent.identity == preflight.destination_parent.identity
            && source.is_none()
            && *destination == Some(preflight.source_identity)
        {
            return Ok(());
        }
    }

    let Ok((source_parent, destination_parent, source, destination)) = observation else {
        return Err(move_directory_error(
            codes.outcome_uncertain,
            "The relocation completed but its result could not be verified",
        ));
    };
    let Some(rollback_identity) = destination else {
        return Err(move_directory_error(
            codes.outcome_uncertain,
            "The relocated item could not be found for rollback",
        ));
    };
    if source.is_some()
        || (codes.strict_rollback_identity
            && (rollback_identity != preflight.source_identity
                || source_parent.identity != preflight.source_parent.identity
                || destination_parent.identity != preflight.destination_parent.identity))
    {
        return Err(move_directory_error(
            codes.outcome_uncertain,
            "The relocation paths changed before rollback",
        ));
    }
    observer.on_phase(MoveCommitPhase::BeforeRollback);
    validate_directory_identity(
        &preflight.root.path,
        &preflight.root.directory,
        "WORKSPACE_ROOT_CHANGED",
    )
    .map_err(|_| {
        move_directory_error(
            codes.outcome_uncertain,
            "The workspace root changed before rollback",
        )
    })?;
    secure_workspace_rename(
        &preflight.root,
        &destination_relative,
        &source_relative,
        codes,
    )
    .map_err(|_| {
        move_directory_error(
            codes.outcome_uncertain,
            "The relocation result could not be rolled back safely",
        )
    })?;
    let (_, _, restored, destination_after) =
        observe_relocation_paths(preflight, codes).map_err(|_| {
            move_directory_error(
                codes.outcome_uncertain,
                "The rollback result could not be verified",
            )
        })?;
    if restored != Some(rollback_identity) || destination_after.is_some() {
        return Err(move_directory_error(
            codes.outcome_uncertain,
            "The rollback result did not match the observed item",
        ));
    }
    let code = if source_parent.identity != preflight.source_parent.identity
        || rollback_identity != preflight.source_identity
    {
        codes.source_changed
    } else {
        codes.destination_changed
    };
    Err(move_directory_error(
        code,
        "The filesystem changed during relocation; the item was restored",
    ))
}

#[cfg(unix)]
fn move_workspace_entry_with_observer<O: MoveCommitObserver>(
    state: &WorkspaceState,
    candidate: &MoveCandidate,
    observer: &mut O,
) -> Result<MovedWorkspaceEntry, CommandError> {
    let preflight = move_preflight(
        state,
        Path::new(&candidate.source_path),
        Path::new(&candidate.destination_directory),
    )?;
    if preflight.workspace_generation != candidate.workspace_generation {
        return Err(move_directory_error(
            "WORKSPACE_CHANGED",
            "The active workspace changed before the move",
        ));
    }
    if preflight.source_path != PathBuf::from(&candidate.source_path)
        || identity_token(preflight.source_parent.identity) != candidate.source_parent_identity
        || identity_token(preflight.source_identity) != candidate.source_identity
        || preflight.source_is_directory != candidate.source_is_directory
        || preflight.source_is_bundle != candidate.source_is_bundle
    {
        return Err(move_directory_error(
            "MOVE_SOURCE_CHANGED",
            "The prepared move no longer matches the filesystem",
        ));
    }
    if preflight.destination_directory != PathBuf::from(&candidate.destination_directory)
        || preflight.destination_path != PathBuf::from(&candidate.destination_path)
        || identity_token(preflight.destination_parent.identity) != candidate.destination_identity
    {
        return Err(move_directory_error(
            "MOVE_DESTINATION_CHANGED",
            "The prepared destination no longer matches the filesystem",
        ));
    }
    commit_relocation_with_observer(&preflight, MOVE_RELOCATION_ERRORS, observer)?;
    Ok(MovedWorkspaceEntry {
        original_path: candidate.source_path.clone(),
        moved_path: candidate.destination_path.clone(),
        entry: moved_entry(candidate)?,
    })
}

#[cfg(unix)]
fn move_workspace_entry_impl(
    state: &WorkspaceState,
    candidate: &MoveCandidate,
) -> Result<MovedWorkspaceEntry, CommandError> {
    move_workspace_entry_with_observer(state, candidate, &mut NoopMoveCommitObserver)
}

#[cfg(all(unix, test))]
fn move_workspace_entry_with_hook<F>(
    state: &WorkspaceState,
    candidate: &MoveCandidate,
    hook: F,
) -> Result<MovedWorkspaceEntry, CommandError>
where
    F: FnMut(MoveCommitPhase),
{
    move_workspace_entry_with_observer(state, candidate, &mut TestMoveCommitObserver(hook))
}

#[cfg(unix)]
fn relocation_rename_error(error: Errno, codes: RelocationErrorCodes) -> CommandError {
    match error {
        Errno::EXIST | Errno::NOTEMPTY => move_directory_error(
            codes.destination_exists,
            "An item with the same name already exists in the destination",
        ),
        Errno::XDEV => move_directory_error(
            codes.cross_device.unwrap_or(codes.destination_changed),
            "Cross-device relocation is not supported",
        ),
        Errno::INVAL | Errno::NOTSUP | Errno::OPNOTSUPP => move_directory_error(
            codes.secure_unavailable,
            "This volume does not support secure workspace relocation",
        ),
        Errno::NOENT | Errno::NOTDIR | Errno::LOOP => {
            move_directory_error(codes.source_changed, "The relocation source changed")
        }
        Errno::ACCESS | Errno::PERM => move_directory_error("PERMISSION_DENIED", error.to_string()),
        _ => move_directory_error("IO_ERROR", error.to_string()),
    }
}

#[cfg(all(unix, test))]
fn move_rename_error(error: Errno) -> CommandError {
    relocation_rename_error(error, MOVE_RELOCATION_ERRORS)
}

#[cfg(unix)]
fn rename_workspace_entry_with_observer<O: MoveCommitObserver>(
    state: &WorkspaceState,
    candidate: &RenameCandidate,
    observer: &mut O,
) -> Result<RenamedWorkspaceEntry, CommandError> {
    let source_path = Path::new(&candidate.source_path);
    let destination_path = Path::new(&candidate.destination_path);
    let destination_name = destination_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            move_directory_error("RENAME_PARENT_CHANGED", "Invalid rename destination")
        })?;
    if source_path.parent() != destination_path.parent() {
        return Err(move_directory_error(
            "RENAME_PARENT_CHANGED",
            "Rename must stay in the same parent folder",
        ));
    }
    let preflight = rename_preflight(state, source_path, destination_name)?;
    if preflight.workspace_generation != candidate.workspace_generation {
        return Err(move_directory_error(
            "WORKSPACE_CHANGED",
            "The active workspace changed before rename",
        ));
    }
    if preflight.source_path != PathBuf::from(&candidate.source_path)
        || identity_token(preflight.source_parent.identity) != candidate.parent_identity
        || identity_token(preflight.source_identity) != candidate.source_identity
        || preflight.source_is_directory != candidate.source_is_directory
        || preflight.source_is_bundle != candidate.source_is_bundle
    {
        return Err(move_directory_error(
            "RENAME_SOURCE_CHANGED",
            "The prepared rename no longer matches the filesystem",
        ));
    }
    if preflight.destination_path != PathBuf::from(&candidate.destination_path)
        || preflight.destination_directory != preflight.source_parent.path
        || preflight.destination_parent.identity != preflight.source_parent.identity
    {
        return Err(move_directory_error(
            "RENAME_PARENT_CHANGED",
            "The prepared rename destination no longer matches the filesystem",
        ));
    }
    commit_relocation_with_observer(&preflight, RENAME_RELOCATION_ERRORS, observer)?;
    Ok(RenamedWorkspaceEntry {
        original_path: candidate.source_path.clone(),
        renamed_path: candidate.destination_path.clone(),
        entry: renamed_entry(candidate)?,
    })
}

#[cfg(unix)]
fn rename_workspace_entry_impl(
    state: &WorkspaceState,
    candidate: &RenameCandidate,
) -> Result<RenamedWorkspaceEntry, CommandError> {
    rename_workspace_entry_with_observer(state, candidate, &mut NoopMoveCommitObserver)
}

#[cfg(all(unix, test))]
fn rename_workspace_entry_with_hook<F>(
    state: &WorkspaceState,
    candidate: &RenameCandidate,
    hook: F,
) -> Result<RenamedWorkspaceEntry, CommandError>
where
    F: FnMut(MoveCommitPhase),
{
    rename_workspace_entry_with_observer(state, candidate, &mut TestMoveCommitObserver(hook))
}

#[cfg(unix)]
fn identity_at(directory: &OwnedFd, name: &std::ffi::OsStr) -> Result<Option<FileIdentity>, ()> {
    match unix_fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(Some(FileIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
        })),
        Err(Errno::NOENT | Errno::NOTDIR) => Ok(None),
        Err(_) => Err(()),
    }
}

#[cfg(unix)]
fn reconcile_workspace_move_impl(
    state: &WorkspaceState,
    candidate: &MoveCandidate,
) -> Result<MoveReconciliation, CommandError> {
    let (root, generation) =
        active_workspace_capability_with_generation(state).map_err(CommandError::legacy)?;
    if generation != candidate.workspace_generation {
        return Err(move_directory_error(
            "WORKSPACE_CHANGED",
            "The active workspace changed before reconciliation",
        ));
    }
    let source_path = Path::new(&candidate.source_path);
    let Some(source_parent_path) = source_path.parent() else {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    let Some(source_name) = source_path.file_name() else {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    if Path::new(&candidate.destination_directory).join(source_name)
        != PathBuf::from(&candidate.destination_path)
    {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    }
    let Ok(source_parent) = open_move_directory(
        &root,
        source_parent_path,
        "MOVE_SOURCE_CHANGED",
        MOVE_RELOCATION_ERRORS.bundle_boundary,
    ) else {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    let Ok(destination) = open_move_directory(
        &root,
        Path::new(&candidate.destination_directory),
        "MOVE_DESTINATION_CHANGED",
        MOVE_RELOCATION_ERRORS.bundle_boundary,
    ) else {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    if identity_token(source_parent.identity) != candidate.source_parent_identity
        || identity_token(destination.identity) != candidate.destination_identity
    {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Ambiguous,
            entry: None,
        });
    }
    let expected = &candidate.source_identity;
    let source_matches = identity_at(&source_parent.directory, source_name)
        .map(|identity| identity.map(identity_token).as_ref() == Some(expected))
        .unwrap_or(false);
    let destination_matches = identity_at(&destination.directory, source_name)
        .map(|identity| identity.map(identity_token).as_ref() == Some(expected))
        .unwrap_or(false);
    if destination_matches && !source_matches {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Destination,
            entry: Some(moved_entry(candidate)?),
        });
    }
    if source_matches && !destination_matches {
        return Ok(MoveReconciliation {
            outcome: MoveReconciliationOutcome::Source,
            entry: None,
        });
    }
    Ok(MoveReconciliation {
        outcome: MoveReconciliationOutcome::Ambiguous,
        entry: None,
    })
}

#[cfg(unix)]
fn reconcile_workspace_rename_impl(
    state: &WorkspaceState,
    candidate: &RenameCandidate,
) -> Result<RenameReconciliation, CommandError> {
    let (root, generation) =
        active_workspace_capability_with_generation(state).map_err(CommandError::legacy)?;
    if generation != candidate.workspace_generation {
        return Err(move_directory_error(
            "WORKSPACE_CHANGED",
            "The active workspace changed before rename reconciliation",
        ));
    }
    let source_path = Path::new(&candidate.source_path);
    let destination_path = Path::new(&candidate.destination_path);
    let (Some(source_parent_path), Some(destination_parent_path)) =
        (source_path.parent(), destination_path.parent())
    else {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    let (Some(source_name), Some(destination_name)) =
        (source_path.file_name(), destination_path.file_name())
    else {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    if source_parent_path != destination_parent_path || source_name == destination_name {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    }
    let Ok(source_parent) = open_move_directory(
        &root,
        source_parent_path,
        RENAME_RELOCATION_ERRORS.source_changed,
        RENAME_RELOCATION_ERRORS.bundle_boundary,
    ) else {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    let Ok(destination_parent) = open_move_directory(
        &root,
        destination_parent_path,
        RENAME_RELOCATION_ERRORS.destination_changed,
        RENAME_RELOCATION_ERRORS.bundle_boundary,
    ) else {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    };
    if source_parent.identity != destination_parent.identity
        || identity_token(source_parent.identity) != candidate.parent_identity
    {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Ambiguous,
            entry: None,
        });
    }
    let expected = &candidate.source_identity;
    let source_matches = identity_at(&source_parent.directory, source_name)
        .map(|identity| identity.map(identity_token).as_ref() == Some(expected))
        .unwrap_or(false);
    let destination_matches = identity_at(&destination_parent.directory, destination_name)
        .map(|identity| identity.map(identity_token).as_ref() == Some(expected))
        .unwrap_or(false);
    if destination_matches && !source_matches {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Destination,
            entry: Some(renamed_entry(candidate)?),
        });
    }
    if source_matches && !destination_matches {
        return Ok(RenameReconciliation {
            outcome: RenameReconciliationOutcome::Source,
            entry: None,
        });
    }
    Ok(RenameReconciliation {
        outcome: RenameReconciliationOutcome::Ambiguous,
        entry: None,
    })
}

#[tauri::command]
fn prepare_workspace_move(
    source_path: String,
    destination_directory: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<MoveCandidate, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (source_path, destination_directory, window, registry);
        Err(CommandError::new(
            "MOVE_SECURE_RENAME_UNAVAILABLE",
            "Secure workspace moves are unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        prepare_workspace_move_impl(
            &state,
            Path::new(&source_path),
            Path::new(&destination_directory),
        )
    }
}

#[tauri::command]
fn move_workspace_entry(
    candidate: MoveCandidate,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<MovedWorkspaceEntry, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (candidate, window, registry);
        Err(CommandError::new(
            "MOVE_SECURE_RENAME_UNAVAILABLE",
            "Secure workspace moves are unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        move_workspace_entry_impl(&state, &candidate)
    }
}

#[tauri::command]
fn reconcile_workspace_move(
    candidate: MoveCandidate,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<MoveReconciliation, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (candidate, window, registry);
        Err(CommandError::new(
            "MOVE_SOURCE_UNSUPPORTED",
            "Workspace moves are unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        reconcile_workspace_move_impl(&state, &candidate)
    }
}

#[tauri::command]
fn prepare_workspace_rename(
    source_path: String,
    new_name: String,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<RenameCandidate, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (source_path, new_name, window, registry);
        Err(CommandError::new(
            "RENAME_SECURE_UNAVAILABLE",
            "Secure workspace rename is unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        prepare_workspace_rename_impl(&state, Path::new(&source_path), &new_name)
    }
}

#[tauri::command]
fn rename_workspace_entry(
    candidate: RenameCandidate,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<RenamedWorkspaceEntry, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (candidate, window, registry);
        Err(CommandError::new(
            "RENAME_SECURE_UNAVAILABLE",
            "Secure workspace rename is unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        rename_workspace_entry_impl(&state, &candidate)
    }
}

#[tauri::command]
fn reconcile_workspace_rename(
    candidate: RenameCandidate,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<RenameReconciliation, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (candidate, window, registry);
        Err(CommandError::new(
            "RENAME_SOURCE_UNSUPPORTED",
            "Workspace rename is unavailable on this platform",
        ))
    }
    #[cfg(unix)]
    {
        let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
        reconcile_workspace_rename_impl(&state, &candidate)
    }
}

#[tauri::command]
fn find_workspace_root(file_path: String) -> Result<String, String> {
    let source = fs::canonicalize(file_path).map_err(|error| error.to_string())?;
    let source_is_dir = source.is_dir();
    let start = if source_is_dir && !is_document_bundle(&source, source_is_dir) {
        source
    } else {
        source
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "The selected file has no parent directory".to_string())?
    };

    let fallback = start.clone();
    let markers = [
        ".localview-root",
        ".git",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
    ];
    let mut candidate = start;

    for _ in 0..8 {
        if markers.iter().any(|marker| candidate.join(marker).exists()) {
            return Ok(candidate.to_string_lossy().into_owned());
        }
        if !candidate.pop() {
            break;
        }
    }

    Ok(fallback.to_string_lossy().into_owned())
}

#[tauri::command]
fn prepare_html_preview(
    path: String,
    window: WebviewWindow,
    workspace_registry: tauri::State<'_, WorkspaceRegistry>,
    preview_state: tauri::State<'_, PreviewState>,
) -> Result<HtmlPreviewCapability, CommandError> {
    let workspace_state =
        workspace_for_window(&workspace_registry, &window).map_err(CommandError::legacy)?;
    let document = scoped_existing_path(&workspace_state, &path).map_err(CommandError::legacy)?;
    if !document.is_file() || !matches!(extension_lowercase(&document).as_str(), "html" | "htm") {
        return Err(CommandError::new(
            "IO_ERROR",
            "HTML preview requires an existing HTML file",
        ));
    }
    let (root, workspace_generation) =
        active_workspace_snapshot(&workspace_state).map_err(CommandError::legacy)?;
    if !document.starts_with(&root) {
        return Err(CommandError::new(
            "WORKSPACE_CHANGED",
            "HTML document is outside the active workspace",
        ));
    }
    let nonce = preview_state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let token_source = format!(
        "{}:{}:{workspace_generation}:{nonce}:{timestamp}:{}",
        std::process::id(),
        window.label(),
        document.to_string_lossy()
    );
    let token = Sha256::digest(token_source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let capability = PreviewCapability {
        window_label: window.label().to_string(),
        root,
        document: document.clone(),
        workspace_generation,
    };
    preview_state
        .capabilities
        .lock()
        .map_err(|_| CommandError::new("IO_ERROR", "Preview state is unavailable"))?
        .insert(token.clone(), capability);
    Ok(HtmlPreviewCapability {
        token,
        document_path: document.to_string_lossy().into_owned(),
        workspace_generation,
    })
}

#[tauri::command]
fn release_html_preview(
    token: String,
    window: WebviewWindow,
    preview_state: tauri::State<'_, PreviewState>,
) -> Result<(), CommandError> {
    release_html_preview_for_label(&token, window.label(), &preview_state)
}

fn release_html_preview_for_label(
    token: &str,
    window_label: &str,
    preview_state: &PreviewState,
) -> Result<(), CommandError> {
    let mut capabilities = preview_state
        .capabilities
        .lock()
        .map_err(|_| CommandError::new("IO_ERROR", "Preview state is unavailable"))?;
    let Some(capability) = capabilities.get(token) else {
        return Err(CommandError::new(
            "IO_ERROR",
            "HTML preview capability is unavailable",
        ));
    };
    if capability.window_label != window_label {
        return Err(CommandError::new(
            "WORKSPACE_CHANGED",
            "HTML preview capability belongs to another window",
        ));
    }
    capabilities.remove(token);
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum RestoreMode {
    None,
    #[serde(rename = "self")]
    SelfSession,
    LastActive,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowBootstrap {
    initial_path: Option<String>,
    session_id: String,
    restore_mode: RestoreMode,
}

#[derive(Clone)]
struct BootstrapEntry {
    bootstrap: WindowBootstrap,
    consumed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupOpenRoute {
    BootstrapAssigned,
    LiveMain,
    Dynamic,
}

struct WindowOpenState {
    process_namespace: String,
    next_id: u64,
    bootstraps: HashMap<String, BootstrapEntry>,
    ready: HashSet<String>,
    last_focused: Option<String>,
    startup_duplicate: Option<String>,
    startup_bootstrap_gate_open: bool,
    startup_main_claim_open: bool,
}

struct WindowOpenRegistry {
    inner: Mutex<WindowOpenState>,
    startup_routing_ready: Condvar,
}

impl Default for WindowOpenRegistry {
    fn default() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let digest = opaque_scope([
            std::process::id().to_string(),
            timestamp.to_string(),
            "localview-window-process".to_string(),
        ]);
        Self {
            inner: Mutex::new(WindowOpenState {
                process_namespace: digest.chars().take(20).collect(),
                next_id: 0,
                bootstraps: HashMap::new(),
                ready: HashSet::new(),
                last_focused: None,
                startup_duplicate: None,
                startup_bootstrap_gate_open: false,
                startup_main_claim_open: false,
            }),
            startup_routing_ready: Condvar::new(),
        }
    }
}

impl WindowOpenRegistry {
    fn register_main(&self, initial_path: Option<String>) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        state.startup_duplicate = initial_path.clone();
        state.startup_bootstrap_gate_open = initial_path.is_none();
        state.startup_main_claim_open = initial_path.is_none();
        let bootstrap = WindowBootstrap {
            initial_path,
            session_id: format!("{}.0", state.process_namespace),
            restore_mode: if state.startup_duplicate.is_some() {
                RestoreMode::None
            } else {
                RestoreMode::LastActive
            },
        };
        state.bootstraps.insert(
            "main".to_string(),
            BootstrapEntry {
                bootstrap,
                consumed: false,
            },
        );
        state.last_focused = Some("main".to_string());
        Ok(())
    }

    fn route_startup_open_to_main(&self, path: String) -> Result<StartupOpenRoute, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        if !state.startup_main_claim_open {
            return Ok(StartupOpenRoute::Dynamic);
        }

        state.startup_main_claim_open = false;
        state.startup_bootstrap_gate_open = false;
        state.startup_duplicate = Some(path.clone());
        self.startup_routing_ready.notify_all();

        let entry = state
            .bootstraps
            .get_mut("main")
            .ok_or_else(|| "WINDOW_BOOTSTRAP_NOT_FOUND".to_string())?;
        if entry.consumed {
            return Ok(StartupOpenRoute::LiveMain);
        }
        entry.bootstrap.initial_path = Some(path);
        entry.bootstrap.restore_mode = RestoreMode::None;
        Ok(StartupOpenRoute::BootstrapAssigned)
    }

    fn finish_startup_bootstrap_gate(&self) {
        if let Ok(mut state) = self.inner.lock() {
            if state.startup_bootstrap_gate_open {
                state.startup_bootstrap_gate_open = false;
                self.startup_routing_ready.notify_all();
            }
        }
    }

    fn finish_window_startup(&self, label: &str) -> Result<(), String> {
        if label != "main" {
            return Ok(());
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        state.startup_main_claim_open = false;
        state.startup_duplicate = None;
        Ok(())
    }

    fn wait_for_startup_routing(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        while state.startup_bootstrap_gate_open {
            state = self
                .startup_routing_ready
                .wait(state)
                .map_err(|_| "Window open registry is unavailable".to_string())?;
        }
        Ok(())
    }

    fn reserve_dynamic(
        &self,
        initial_path: Option<String>,
        restore_mode: RestoreMode,
    ) -> Result<(String, WindowBootstrap), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        loop {
            state.next_id = state.next_id.saturating_add(1);
            let id = state.next_id;
            let label = format!("workspace-{}-{id}", state.process_namespace);
            if state.bootstraps.contains_key(&label) {
                continue;
            }
            let bootstrap = WindowBootstrap {
                initial_path,
                session_id: format!("{}.{id}", state.process_namespace),
                restore_mode,
            };
            state.bootstraps.insert(
                label.clone(),
                BootstrapEntry {
                    bootstrap: bootstrap.clone(),
                    consumed: false,
                },
            );
            return Ok((label, bootstrap));
        }
    }

    fn rollback_reservation(&self, label: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.bootstraps.remove(label);
            state.ready.remove(label);
        }
    }

    fn consume_bootstrap(&self, label: &str) -> Result<WindowBootstrap, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Window open registry is unavailable".to_string())?;
        let entry = state
            .bootstraps
            .get_mut(label)
            .ok_or_else(|| "WINDOW_BOOTSTRAP_NOT_FOUND".to_string())?;
        let result = if entry.consumed {
            WindowBootstrap {
                initial_path: None,
                session_id: entry.bootstrap.session_id.clone(),
                restore_mode: RestoreMode::SelfSession,
            }
        } else {
            entry.consumed = true;
            entry.bootstrap.clone()
        };
        state.ready.insert(label.to_string());
        Ok(result)
    }

    fn remove(&self, label: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.bootstraps.remove(label);
            state.ready.remove(label);
            if state.last_focused.as_deref() == Some(label) {
                state.last_focused = None;
            }
        }
    }

    fn focus(&self, label: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.last_focused = Some(label.to_string());
        }
    }

    fn last_focused(&self) -> Option<String> {
        self.inner.lock().ok()?.last_focused.clone()
    }

    fn consume_startup_duplicate(&self, path: &str) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if state.startup_duplicate.as_deref() == Some(path) {
            state.startup_duplicate = None;
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AppQuitOutcome {
    Saved,
    DiscardApproved,
    Cancel,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppQuitEvent {
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitPhase {
    Idle,
    Preparing,
    Exiting,
}

struct QuitState {
    phase: QuitPhase,
    generation: u64,
    participants: HashSet<String>,
    pending: HashSet<String>,
    responses: HashMap<String, AppQuitOutcome>,
    allow_exit: bool,
}

struct QuitRegistry {
    inner: Mutex<QuitState>,
}

impl Default for QuitRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(QuitState {
                phase: QuitPhase::Idle,
                generation: 0,
                participants: HashSet::new(),
                pending: HashSet::new(),
                responses: HashMap::new(),
                allow_exit: false,
            }),
        }
    }
}

enum QuitAction {
    None,
    Abort {
        generation: u64,
        participants: Vec<String>,
    },
    Exit,
}

#[cfg(target_os = "macos")]
const APP_QUIT_MENU_ID: &str = "localview-app-quit";
#[cfg(target_os = "macos")]
const APP_PRINT_MENU_ID: &str = "localview-print";
#[cfg(target_os = "macos")]
const PRINT_REQUESTED_EVENT: &str = "print-requested";

impl QuitRegistry {
    fn begin(&self, labels: HashSet<String>) -> Result<Option<(u64, Vec<String>)>, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Quit registry is unavailable".to_string())?;
        if state.phase != QuitPhase::Idle {
            return Ok(None);
        }
        state.generation = state.generation.saturating_add(1);
        state.phase = QuitPhase::Preparing;
        state.participants = labels.clone();
        state.pending = labels;
        state.responses.clear();
        Ok(Some((
            state.generation,
            state.participants.iter().cloned().collect(),
        )))
    }

    fn consume_allow_exit(&self) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if state.allow_exit {
            state.allow_exit = false;
            true
        } else {
            false
        }
    }

    fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|state| state.phase != QuitPhase::Idle)
            .unwrap_or(true)
    }

    fn respond(
        &self,
        label: &str,
        generation: u64,
        outcome: AppQuitOutcome,
    ) -> Result<QuitAction, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Quit registry is unavailable".to_string())?;
        if state.phase != QuitPhase::Preparing || state.generation != generation {
            return Err("APP_QUIT_STALE_GENERATION".to_string());
        }
        if !state.pending.contains(label) {
            return Err("APP_QUIT_DUPLICATE_OR_UNKNOWN_WINDOW".to_string());
        }
        if outcome == AppQuitOutcome::Cancel {
            let participants = state.participants.iter().cloned().collect();
            state.phase = QuitPhase::Idle;
            state.pending.clear();
            state.responses.clear();
            state.participants.clear();
            return Ok(QuitAction::Abort {
                generation,
                participants,
            });
        }
        state.pending.remove(label);
        state.responses.insert(label.to_string(), outcome);
        if state.pending.is_empty() {
            state.phase = QuitPhase::Exiting;
            state.allow_exit = true;
            Ok(QuitAction::Exit)
        } else {
            Ok(QuitAction::None)
        }
    }

    fn abort(&self) -> Option<(u64, Vec<String>)> {
        let mut state = self.inner.lock().ok()?;
        if state.phase != QuitPhase::Preparing {
            return None;
        }
        let generation = state.generation;
        let participants = state.participants.iter().cloned().collect();
        state.phase = QuitPhase::Idle;
        state.pending.clear();
        state.responses.clear();
        state.participants.clear();
        Some((generation, participants))
    }

    fn destroyed(&self, label: &str) -> QuitAction {
        let Ok(mut state) = self.inner.lock() else {
            return QuitAction::None;
        };
        if state.phase != QuitPhase::Preparing || !state.pending.remove(label) {
            return QuitAction::None;
        }
        state.participants.remove(label);
        if state.pending.is_empty() {
            state.phase = QuitPhase::Exiting;
            state.allow_exit = true;
            QuitAction::Exit
        } else {
            QuitAction::None
        }
    }
}

fn argument_to_path(value: String) -> Option<PathBuf> {
    if value.starts_with('-') {
        return None;
    }

    let path = if let Ok(url) = url::Url::parse(&value) {
        url.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };

    fs::canonicalize(path).ok()
}

fn startup_path_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find_map(argument_to_path)
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn get_window_bootstrap(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<WindowBootstrap, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WindowOpenRegistry>();
        state.wait_for_startup_routing()?;
        state.consume_bootstrap(&label)
    })
    .await
    .map_err(|error| format!("WINDOW_BOOTSTRAP_TASK_FAILED: {error}"))?
}

#[tauri::command]
fn finish_window_startup(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    app.state::<WindowOpenRegistry>()
        .finish_window_startup(window.label())
}

async fn build_workspace_window(
    app: tauri::AppHandle,
    initial_path: Option<String>,
    restore_mode: RestoreMode,
) -> Result<String, String> {
    let registry = app.state::<WindowOpenRegistry>();
    let (label, _) = registry.reserve_dynamic(initial_path, restore_mode)?;
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "WINDOW_TEMPLATE_MISSING".to_string())?;
    config.label = label.clone();
    if app.get_webview_window(&label).is_some() {
        registry.rollback_reservation(&label);
        return Err("WINDOW_LABEL_COLLISION".to_string());
    }
    let result = tauri::WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map_err(|error| format!("WINDOW_CREATE_FAILED: {error}"));
    match result {
        Ok(_) => Ok(label),
        Err(error) => {
            registry.rollback_reservation(&label);
            Err(error)
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowOpenFailure {
    path: Option<String>,
    message: String,
}

fn report_window_open_failure(app: &tauri::AppHandle, path: Option<String>, message: String) {
    let registry = app.state::<WindowOpenRegistry>();
    let target = registry
        .last_focused()
        .filter(|label| app.get_webview_window(label).is_some())
        .or_else(|| app.webview_windows().keys().next().cloned());
    let payload = WindowOpenFailure {
        path,
        message: message.clone(),
    };
    if let Some(label) = target {
        if app
            .emit_to(&label, "workspace-window-open-failed", payload)
            .is_ok()
        {
            return;
        }
    }
    eprintln!("LocalView window open failed: {message}");
}

fn emit_quit_abort(
    app: &tauri::AppHandle,
    generation: u64,
    participants: impl IntoIterator<Item = String>,
) {
    for label in participants {
        if app.get_webview_window(&label).is_some() {
            let _ = app.emit_to(&label, "app-quit-aborted", AppQuitEvent { generation });
        }
    }
}

fn request_app_quit(app: &tauri::AppHandle) {
    let labels = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    if labels.is_empty() {
        app.exit(0);
        return;
    }
    match app.state::<QuitRegistry>().begin(labels) {
        Ok(Some((generation, participants))) => {
            for label in participants {
                let _ = app.emit_to(&label, "app-quit-requested", AppQuitEvent { generation });
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("Failed to begin application quit: {error}"),
    }
}

async fn route_external_open_requests(app: tauri::AppHandle, paths: Vec<PathBuf>) {
    if let Some((generation, participants)) = app.state::<QuitRegistry>().abort() {
        emit_quit_abort(&app, generation, participants);
    }
    if paths.is_empty() {
        if let Err(error) = build_workspace_window(app.clone(), None, RestoreMode::None).await {
            report_window_open_failure(&app, None, error);
        }
        return;
    }
    for path in paths {
        let path = path.to_string_lossy().into_owned();
        if let Err(error) =
            build_workspace_window(app.clone(), Some(path.clone()), RestoreMode::None).await
        {
            report_window_open_failure(&app, Some(path), error);
        }
    }
}

#[tauri::command]
async fn new_workspace_window(
    app: tauri::AppHandle,
    quit: tauri::State<'_, QuitRegistry>,
) -> Result<String, String> {
    if quit.is_active() {
        return Err("QUIT_IN_PROGRESS".to_string());
    }
    build_workspace_window(app, None, RestoreMode::None).await
}

#[tauri::command]
fn print_current_window(window: WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        return window
            .print()
            .map_err(|error| format!("PRINT_DISPATCH_FAILED: {error}"));
    }

    #[cfg(not(desktop))]
    {
        let _ = window;
        Err("PRINT_UNSUPPORTED".to_string())
    }
}

#[tauri::command]
fn respond_app_quit(
    generation: u64,
    outcome: AppQuitOutcome,
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, QuitRegistry>,
) -> Result<(), String> {
    match state.respond(window.label(), generation, outcome)? {
        QuitAction::None => {}
        QuitAction::Abort {
            generation,
            participants,
        } => emit_quit_abort(&app, generation, participants),
        QuitAction::Exit => app.exit(0),
    }
    Ok(())
}

fn focus_last_workspace_window(app: &tauri::AppHandle) -> bool {
    let registry = app.state::<WindowOpenRegistry>();
    let target = registry
        .last_focused()
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.webview_windows().into_values().next());
    let Some(window) = target else {
        return false;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    true
}

#[cfg(target_os = "macos")]
fn select_print_target_label(
    window_states: &[(String, bool)],
    last_focused: Option<&str>,
) -> Option<String> {
    window_states
        .iter()
        .find(|(_, focused)| *focused)
        .map(|(label, _)| label.clone())
        .or_else(|| {
            last_focused.and_then(|label| {
                window_states
                    .iter()
                    .any(|(candidate, _)| candidate == label)
                    .then(|| label.to_string())
            })
        })
}

#[cfg(target_os = "macos")]
fn print_menu_insert_position(item_labels: &[String]) -> Option<usize> {
    item_labels.iter().position(|label| label.contains("Close"))
}

#[cfg(target_os = "macos")]
fn request_print_for_focused_window(app: &tauri::AppHandle) {
    let window_states = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| (label, window.is_focused().unwrap_or(false)))
        .collect::<Vec<_>>();
    let last_focused = app.state::<WindowOpenRegistry>().last_focused();
    let Some(label) = select_print_target_label(&window_states, last_focused.as_deref()) else {
        return;
    };
    if let Err(error) = app.emit_to(&label, PRINT_REQUESTED_EVENT, ()) {
        eprintln!("Failed to request printing for {label}: {error}");
    }
}

fn cleanup_window_runtime(app: &tauri::AppHandle, label: &str) {
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let _ = workspace_registry.retire(label);
    if let Ok(mut capabilities) = app.state::<PreviewState>().capabilities.lock() {
        capabilities.retain(|_, capability| capability.window_label != label);
    }
    app.state::<WindowOpenRegistry>().remove(label);
    quick_look::cleanup_window_previews(app, label);
    if matches!(
        app.state::<QuitRegistry>().destroyed(label),
        QuitAction::Exit
    ) {
        app.exit(0);
    }
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "txt" | "md" | "markdown" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn protocol_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff");
    if content_type.starts_with("text/html") {
        response = response.header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; script-src 'unsafe-inline' localview: blob:; style-src 'unsafe-inline' localview:; img-src localview: data: blob:; font-src localview: data:; media-src localview: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri localview:; navigate-to 'none'",
        );
    }
    response.body(body).expect("valid local asset response")
}

fn local_asset_response(
    state: &WorkspaceState,
    preview_state: &PreviewState,
    window_label: &str,
    uri_path: &str,
) -> Response<Vec<u8>> {
    let result = (|| -> Result<(PathBuf, Vec<u8>), StatusCode> {
        let raw_path = uri_path.trim_start_matches('/');
        let (root, workspace_generation, capability_document, encoded_relative) =
            if let Some(preview_path) = raw_path.strip_prefix("preview/") {
                let mut parts = preview_path.splitn(2, '/');
                let token = parts.next().ok_or(StatusCode::FORBIDDEN)?;
                let relative = parts.next().ok_or(StatusCode::BAD_REQUEST)?;
                let capability = preview_state
                    .capabilities
                    .lock()
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                    .get(token)
                    .cloned()
                    .ok_or(StatusCode::FORBIDDEN)?;
                if capability.window_label != window_label {
                    return Err(StatusCode::FORBIDDEN);
                }
                let (active_root, active_generation) =
                    active_workspace_snapshot(state).map_err(|_| StatusCode::FORBIDDEN)?;
                if active_generation != capability.workspace_generation
                    || active_root != capability.root
                {
                    return Err(StatusCode::FORBIDDEN);
                }
                (
                    capability.root,
                    capability.workspace_generation,
                    Some(capability.document),
                    relative,
                )
            } else if let Some(asset_path) = raw_path.strip_prefix("asset/") {
                let mut parts = asset_path.splitn(2, '/');
                let scope = parts.next().ok_or(StatusCode::FORBIDDEN)?;
                let relative = parts.next().ok_or(StatusCode::BAD_REQUEST)?;
                let (root, generation, active_scope) =
                    active_workspace_binding_snapshot(state).map_err(|_| StatusCode::FORBIDDEN)?;
                if scope != active_scope {
                    return Err(StatusCode::FORBIDDEN);
                }
                (root, generation, None, relative)
            } else {
                return Err(StatusCode::FORBIDDEN);
            };
        let _ = workspace_generation;
        let decoded = percent_decode_str(encoded_relative)
            .decode_utf8()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let relative = Path::new(decoded.as_ref());
        if relative.is_absolute() {
            return Err(StatusCode::FORBIDDEN);
        }
        let requested = root.join(relative);
        let canonical = fs::canonicalize(requested).map_err(|_| StatusCode::NOT_FOUND)?;
        if canonical == root || !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(StatusCode::FORBIDDEN);
        }
        if let Some(document) = capability_document {
            if matches!(extension_lowercase(&canonical).as_str(), "html" | "htm")
                && canonical != document
            {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        let data = fs::read(&canonical).map_err(|_| StatusCode::NOT_FOUND)?;
        Ok((canonical, data))
    })();

    match result {
        Ok((path, data)) => protocol_response(StatusCode::OK, content_type_for(&path), data),
        Err(status) => protocol_response(
            status,
            "text/plain; charset=utf-8",
            b"Local asset unavailable".to_vec(),
        ),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let window_open_registry = WindowOpenRegistry::default();
    window_open_registry
        .register_main(startup_path_from_args(std::env::args()))
        .expect("failed to register the main LocalView window");

    let mut builder = tauri::Builder::default()
        .manage(window_open_registry)
        .manage(WorkspaceRegistry::default())
        .manage(PreviewState::default())
        .manage(QuitRegistry::default())
        .register_uri_scheme_protocol("localview", |context, request| {
            let registry = context.app_handle().state::<WorkspaceRegistry>();
            let preview_state = context.app_handle().state::<PreviewState>();
            match registry.workspace_for_label(context.webview_label()) {
                Ok(state) => local_asset_response(
                    &state,
                    &preview_state,
                    context.webview_label(),
                    request.uri().path(),
                ),
                Err(_) => protocol_response(
                    StatusCode::FORBIDDEN,
                    "text/plain; charset=utf-8",
                    b"Local asset unavailable".to_vec(),
                ),
            }
        });

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = args
                .into_iter()
                .skip(1)
                .filter_map(argument_to_path)
                .collect::<Vec<_>>();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                route_external_open_requests(app, paths).await;
            });
        }));
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};

                let menu = Menu::default(app)?;
                let top_level_items = menu.items()?;
                let app_menu = top_level_items
                    .first()
                    .and_then(|item| match item {
                        MenuItemKind::Submenu(submenu) => Some(submenu.clone()),
                        _ => None,
                    })
                    .ok_or_else(|| tauri::Error::AssetNotFound("macOS app menu".into()))?;
                let app_menu_items = app_menu.items()?;
                let quit_position = app_menu_items
                    .len()
                    .checked_sub(1)
                    .ok_or_else(|| tauri::Error::AssetNotFound("macOS quit menu item".into()))?;
                match app_menu_items.last() {
                    Some(MenuItemKind::Predefined(item)) if item.text()?.contains("Quit") => {}
                    _ => {
                        return Err(tauri::Error::AssetNotFound(
                            "macOS predefined quit menu item".into(),
                        ));
                    }
                }
                app_menu.remove_at(quit_position)?;
                let quit_item = MenuItem::with_id(
                    app,
                    APP_QUIT_MENU_ID,
                    format!("Quit {}", app.package_info().name),
                    true,
                    Some("Cmd+Q"),
                )?;
                app_menu.append(&quit_item)?;

                let file_menu = top_level_items
                    .into_iter()
                    .find_map(|item| match item {
                        MenuItemKind::Submenu(submenu)
                            if submenu.text().ok().as_deref() == Some("File") =>
                        {
                            Some(submenu)
                        }
                        _ => None,
                    })
                    .ok_or_else(|| tauri::Error::AssetNotFound("macOS file menu".into()))?;
                let file_items = file_menu.items()?;
                let file_item_labels = file_items
                    .iter()
                    .map(|item| match item {
                        MenuItemKind::Predefined(item) => item.text().unwrap_or_default(),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>();
                let close_position = print_menu_insert_position(&file_item_labels)
                    .ok_or_else(|| tauri::Error::AssetNotFound("macOS close menu item".into()))?;
                let print_item =
                    MenuItem::with_id(app, APP_PRINT_MENU_ID, "Print…", true, Some("Cmd+P"))?;
                file_menu.insert(&print_item, close_position)?;
                Ok(menu)
            })
            .on_menu_event(|app, event| {
                if event.id() == APP_QUIT_MENU_ID {
                    request_app_quit(app);
                } else if event.id() == APP_PRINT_MENU_ID {
                    request_print_for_focused_window(app);
                }
            });
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_workspace_root,
            list_directory,
            inspect_path,
            read_text_file,
            create_markdown_file,
            create_directory,
            write_text_file,
            image_paste::save_pasted_images,
            prepare_trash,
            move_to_trash,
            prepare_workspace_move,
            move_workspace_entry,
            reconcile_workspace_move,
            prepare_workspace_rename,
            rename_workspace_entry,
            reconcile_workspace_rename,
            find_workspace_root,
            prepare_html_preview,
            release_html_preview,
            get_window_bootstrap,
            finish_window_startup,
            new_workspace_window,
            print_current_window,
            respond_app_quit,
            spreadsheet::read_spreadsheet,
            quick_look::generate_system_thumbnail,
            quick_look::show_embedded_quick_look,
            quick_look::resize_embedded_quick_look,
            quick_look::hide_embedded_quick_look,
            quick_look::open_quick_look,
            quick_look::open_in_default_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building LocalView");

    app.run(|app, event| match event {
        tauri::RunEvent::Ready => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(100));
                app.state::<WindowOpenRegistry>()
                    .finish_startup_bootstrap_gate();
            });
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            let quit = app.state::<QuitRegistry>();
            if quit.consume_allow_exit() {
                return;
            }
            if app.webview_windows().is_empty() {
                return;
            }
            api.prevent_exit();
            request_app_quit(app);
        }
        tauri::RunEvent::WindowEvent { label, event, .. } => match event {
            tauri::WindowEvent::Focused(true) => {
                app.state::<WindowOpenRegistry>().focus(&label);
            }
            tauri::WindowEvent::Destroyed => cleanup_window_runtime(app, &label),
            _ => {}
        },
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let registry = app.state::<WindowOpenRegistry>();
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter_map(|path| fs::canonicalize(path).ok())
                .collect::<Vec<_>>();
            let mut dynamic_paths = Vec::new();
            for path in paths {
                let path_string = path.to_string_lossy().into_owned();
                if registry.consume_startup_duplicate(&path_string) {
                    continue;
                }
                match registry.route_startup_open_to_main(path_string.clone()) {
                    Ok(StartupOpenRoute::BootstrapAssigned) => {}
                    Ok(StartupOpenRoute::LiveMain) => {
                        if app.emit_to("main", "open-path", path_string).is_err() {
                            dynamic_paths.push(path);
                        } else if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    Ok(StartupOpenRoute::Dynamic) => dynamic_paths.push(path),
                    Err(error) => {
                        report_window_open_failure(app, Some(path_string), error);
                        dynamic_paths.push(path);
                    }
                }
            }
            if !dynamic_paths.is_empty() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    route_external_open_requests(app, dynamic_paths).await;
                });
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if !focus_last_workspace_window(app) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        build_workspace_window(app.clone(), None, RestoreMode::LastActive).await
                    {
                        report_window_open_failure(&app, None, error);
                    }
                });
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::{
        collections::BTreeMap,
        sync::{Arc, Barrier},
    };

    #[derive(Deserialize)]
    struct MarkdownFilenameCase {
        input: String,
        expected: Option<String>,
        error: Option<String>,
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "localview-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ))
    }

    fn workspace_state(root: &Path) -> WorkspaceState {
        WorkspaceState {
            context: Mutex::new(WorkspaceContext {
                root: Some(open_workspace_root(root).expect("open workspace root")),
                generation: 1,
                asset_scope: "test-asset-scope".to_string(),
                watcher: None,
            }),
            next_generation: AtomicU64::new(1),
            next_asset_id: AtomicU64::new(1),
        }
    }

    #[test]
    fn markdown_file_names_match_the_shared_contract() {
        let cases: Vec<MarkdownFilenameCase> = serde_json::from_str(include_str!(
            "../../src/test/fixtures/markdown-filename-cases.json"
        ))
        .expect("parse shared markdown filename cases");

        for case in cases {
            let result = normalize_markdown_file_name(&case.input);
            match (case.expected, case.error) {
                (Some(expected), None) => assert_eq!(
                    result.unwrap(),
                    expected,
                    "unexpected normalization for {:?}",
                    case.input
                ),
                (None, Some(error)) => assert_eq!(
                    result.unwrap_err(),
                    error,
                    "unexpected rejection for {:?}",
                    case.input
                ),
                _ => panic!("fixture case must define exactly one result"),
            }
        }
    }

    #[test]
    fn directory_names_match_the_shared_contract() {
        let cases: Vec<MarkdownFilenameCase> = serde_json::from_str(include_str!(
            "../../src/test/fixtures/directory-name-cases.json"
        ))
        .expect("parse shared directory name cases");

        for case in cases {
            let result = normalize_directory_name(&case.input);
            match (case.expected, case.error) {
                (Some(expected), None) => assert_eq!(
                    result.unwrap(),
                    expected,
                    "unexpected normalization for {:?}",
                    case.input
                ),
                (None, Some(error)) => assert_eq!(
                    result.unwrap_err(),
                    error,
                    "unexpected rejection for {:?}",
                    case.input
                ),
                _ => panic!("fixture case must define exactly one result"),
            }
        }
    }

    #[test]
    fn failed_workspace_replacement_preserves_the_previous_root() {
        let root = unique_temp_dir("workspace-preserve");
        fs::create_dir_all(&root).expect("create workspace");
        let invalid = root.join("not-a-directory.txt");
        fs::write(&invalid, b"file").expect("create invalid candidate");
        let state = workspace_state(&root);
        let expected = fs::canonicalize(&root).expect("canonical workspace");

        assert!(set_workspace_root_impl(&state, &invalid).is_err());
        assert_eq!(active_workspace_root(&state).unwrap(), expected);

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn duplicated_workspace_capabilities_are_close_on_exec() {
        use rustix::io::{fcntl_getfd, FdFlags};

        let root = unique_temp_dir("workspace-cloexec");
        fs::create_dir_all(&root).expect("create workspace");
        let state = workspace_state(&root);

        let capability = active_workspace_capability(&state).expect("duplicate capability");
        assert!(fcntl_getfd(&capability.directory)
            .expect("read descriptor flags")
            .contains(FdFlags::CLOEXEC));

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn capability_duplication_releases_the_workspace_mutex_before_io() {
        use std::{sync::mpsc, time::Duration};

        let root = unique_temp_dir("workspace-mutex");
        fs::create_dir_all(&root).expect("create workspace");
        let state = Arc::new(workspace_state(&root));
        let capability = active_workspace_capability(&state).expect("duplicate capability");
        let worker_state = Arc::clone(&state);
        let worker_root = root.clone();
        let (sent, received) = mpsc::channel();

        let worker = std::thread::spawn(move || {
            let result = set_workspace_root_impl(&worker_state, &worker_root);
            sent.send(result).expect("send workspace result");
        });
        assert!(received
            .recv_timeout(Duration::from_secs(1))
            .expect("workspace update must not wait on a retained capability")
            .is_ok());

        drop(capability);
        worker.join().expect("join workspace worker");
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn creates_an_empty_markdown_file_with_an_initial_version() {
        let root = unique_temp_dir("create-markdown");
        fs::create_dir_all(&root).expect("create workspace");
        let state = workspace_state(&root);

        let created =
            create_markdown_file_impl(&state, &root, "会议记录").expect("create markdown file");
        let expected = fs::canonicalize(&root)
            .expect("canonical workspace")
            .join("会议记录.md");

        assert_eq!(created.entry.name, "会议记录.md");
        assert_eq!(created.entry.path, expected.to_string_lossy());
        assert_eq!(created.entry.kind, "md");
        assert_eq!(created.snapshot.content, "");
        assert_eq!(created.snapshot.version, version_for_bytes(b""));
        assert_eq!(fs::metadata(&expected).unwrap().len(), 0);

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn refuses_non_directory_and_iwork_bundle_parents() {
        let root = unique_temp_dir("markdown-parent");
        fs::create_dir_all(root.join("Draft.pages")).expect("create Pages bundle");
        fs::write(root.join("plain.txt"), b"not a directory").expect("create plain file");
        let state = workspace_state(&root);

        for parent in [root.join("plain.txt"), root.join("Draft.pages")] {
            assert_eq!(
                create_markdown_file_impl(&state, &parent, "notes").unwrap_err(),
                "MARKDOWN_PARENT_NOT_DIRECTORY"
            );
        }

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn refuses_workspace_escape_and_external_parent_symlink() {
        let root = unique_temp_dir("markdown-scope");
        let outside = unique_temp_dir("markdown-outside");
        fs::create_dir_all(&root).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside directory");
        let state = workspace_state(&root);

        assert_eq!(
            create_markdown_file_impl(&state, &outside, "escape").unwrap_err(),
            "Path is outside the active workspace"
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("outside-link"))
                .expect("create external directory symlink");
            assert_eq!(
                create_markdown_file_impl(&state, &root.join("outside-link"), "escape")
                    .unwrap_err(),
                "Path is outside the active workspace"
            );
        }

        assert!(!outside.join("escape.md").exists());
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_creation_after_the_workspace_root_is_replaced() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("workspace-root-race");
        let moved = unique_temp_dir("workspace-root-moved");
        let outside = unique_temp_dir("workspace-root-outside");
        fs::create_dir_all(&root).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside directory");
        let state = workspace_state(&root);

        fs::rename(&root, &moved).expect("move workspace root");
        symlink(&outside, &root).expect("replace workspace root with symlink");

        assert_eq!(
            create_markdown_file_impl(&state, &root, "escape").unwrap_err(),
            "WORKSPACE_ROOT_CHANGED"
        );
        assert!(!outside.join("escape.md").exists());
        assert!(!moved.join("escape.md").exists());

        fs::remove_file(root).expect("remove replacement symlink");
        fs::remove_dir_all(moved).expect("remove moved workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_creation_when_parent_changes_after_canonicalization() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("parent-canonical-race");
        let parent = root.join("notes");
        let moved = root.join("notes-moved");
        let outside = unique_temp_dir("parent-canonical-outside");
        fs::create_dir_all(&parent).expect("create parent");
        fs::create_dir_all(&outside).expect("create outside directory");
        let state = workspace_state(&root);

        let result = create_markdown_file_with_hooks(
            &state,
            &parent,
            "escape",
            || {
                fs::rename(&parent, &moved).expect("move parent");
                symlink(&outside, &parent).expect("replace parent with symlink");
            },
            || {},
        );

        assert_eq!(result.unwrap_err(), "MARKDOWN_PARENT_CHANGED");
        assert!(!outside.join("escape.md").exists());
        assert!(!moved.join("escape.md").exists());

        fs::remove_file(parent).expect("remove replacement symlink");
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_creation_when_an_ancestor_changes_after_canonicalization() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("ancestor-canonical-race");
        let ancestor = root.join("notes");
        let parent = ancestor.join("nested");
        let moved = root.join("notes-moved");
        let outside = unique_temp_dir("ancestor-canonical-outside");
        fs::create_dir_all(&parent).expect("create nested parent");
        fs::create_dir_all(outside.join("nested")).expect("create outside nested directory");
        let state = workspace_state(&root);

        let result = create_markdown_file_with_hooks(
            &state,
            &parent,
            "escape",
            || {
                fs::rename(&ancestor, &moved).expect("move ancestor");
                symlink(&outside, &ancestor).expect("replace ancestor with symlink");
            },
            || {},
        );

        assert_eq!(result.unwrap_err(), "MARKDOWN_PARENT_CHANGED");
        assert!(!outside.join("nested/escape.md").exists());
        assert!(!moved.join("nested/escape.md").exists());

        fs::remove_file(ancestor).expect("remove replacement symlink");
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_creation_when_parent_changes_before_final_create() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("parent-create-race");
        let parent = root.join("notes");
        let moved = root.join("notes-moved");
        let outside = unique_temp_dir("parent-create-outside");
        fs::create_dir_all(&parent).expect("create parent");
        fs::create_dir_all(&outside).expect("create outside directory");
        let state = workspace_state(&root);

        let result = create_markdown_file_with_hooks(
            &state,
            &parent,
            "escape",
            || {},
            || {
                fs::rename(&parent, &moved).expect("move parent");
                symlink(&outside, &parent).expect("replace parent with symlink");
            },
        );

        assert_eq!(result.unwrap_err(), "MARKDOWN_PARENT_CHANGED");
        assert!(!outside.join("escape.md").exists());
        assert!(!moved.join("escape.md").exists());

        fs::remove_file(parent).expect("remove replacement symlink");
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[test]
    fn duplicate_markdown_creation_preserves_existing_bytes() {
        let root = unique_temp_dir("markdown-duplicate");
        fs::create_dir_all(&root).expect("create workspace");
        let existing = root.join("notes.md");
        let original = b"# existing\n";
        fs::write(&existing, original).expect("create existing markdown");
        let state = workspace_state(&root);

        assert_eq!(
            create_markdown_file_impl(&state, &root, "notes").unwrap_err(),
            "MARKDOWN_FILE_EXISTS"
        );
        assert_eq!(fs::read(&existing).unwrap(), original);
        assert_eq!(
            version_for_bytes(&fs::read(&existing).unwrap()),
            version_for_bytes(original)
        );

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn concurrent_markdown_creation_has_one_winner() {
        let root = unique_temp_dir("markdown-concurrent");
        fs::create_dir_all(&root).expect("create workspace");
        let state = Arc::new(workspace_state(&root));
        let barrier = Arc::new(Barrier::new(4));
        let mut handles = Vec::new();

        for _ in 0..4 {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            let parent = root.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                create_markdown_file_impl(&state, &parent, "race")
            }));
        }

        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("join creator"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result
                    .as_ref()
                    .err()
                    .is_some_and(|error| error == "MARKDOWN_FILE_EXISTS"))
                .count(),
            3
        );
        assert_eq!(fs::metadata(root.join("race.md")).unwrap().len(), 0);

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn creates_root_and_nested_directories_as_empty_folders() {
        let root = unique_temp_dir("create-directory");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create workspace parent");
        let state = workspace_state(&root);

        let root_entry =
            create_directory_impl(&state, &root, "项目资料").expect("create root directory");
        let nested_entry =
            create_directory_impl(&state, &nested, "Drafts").expect("create nested directory");

        assert_eq!(root_entry.name, "项目资料");
        assert_eq!(root_entry.kind, "folder");
        assert_eq!(nested_entry.name, "Drafts");
        assert_eq!(nested_entry.kind, "folder");
        assert!(root.join("项目资料").is_dir());
        assert!(nested.join("Drafts").is_dir());

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn directory_creation_rejects_duplicate_entries_and_invalid_parents() {
        let root = unique_temp_dir("directory-rejections");
        fs::create_dir_all(root.join("existing-folder")).expect("create duplicate folder");
        fs::create_dir_all(root.join("Draft.pages")).expect("create iWork bundle");
        fs::write(root.join("existing-file"), b"existing").expect("create duplicate file");
        let state = workspace_state(&root);

        for name in ["existing-folder", "existing-file"] {
            assert_eq!(
                create_directory_impl(&state, &root, name).unwrap_err(),
                "DIRECTORY_ENTRY_EXISTS"
            );
        }
        for parent in [root.join("existing-file"), root.join("Draft.pages")] {
            assert_eq!(
                create_directory_impl(&state, &parent, "child").unwrap_err(),
                "DIRECTORY_PARENT_NOT_DIRECTORY"
            );
        }

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn directory_creation_rejects_escape_and_parent_replacement() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("directory-scope");
        let parent = root.join("parent");
        let moved = root.join("parent-moved");
        let outside = unique_temp_dir("directory-outside");
        fs::create_dir_all(&parent).expect("create parent");
        fs::create_dir_all(&outside).expect("create outside");
        let state = workspace_state(&root);

        assert_eq!(
            create_directory_impl(&state, &outside, "escape").unwrap_err(),
            "Path is outside the active workspace"
        );
        let result = create_directory_with_hooks(
            &state,
            &parent,
            "escape",
            || {},
            |phase| {
                if phase == DirectoryCreateHookPhase::BeforeFinalCreate {
                    fs::rename(&parent, &moved).expect("move parent");
                    symlink(&outside, &parent).expect("replace parent");
                }
            },
        );
        assert_eq!(result.unwrap_err(), "DIRECTORY_PARENT_CHANGED");
        assert!(!outside.join("escape").exists());
        assert!(!moved.join("escape").exists());

        fs::remove_file(parent).expect("remove replacement symlink");
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[cfg(unix)]
    #[test]
    fn directory_creation_rejects_replaced_workspace_root() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("directory-root-race");
        let moved = unique_temp_dir("directory-root-moved");
        let outside = unique_temp_dir("directory-root-outside");
        fs::create_dir_all(&root).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside");
        let state = workspace_state(&root);

        fs::rename(&root, &moved).expect("move workspace root");
        symlink(&outside, &root).expect("replace workspace root");

        assert_eq!(
            create_directory_impl(&state, &root, "escape").unwrap_err(),
            "WORKSPACE_ROOT_CHANGED"
        );
        assert!(!outside.join("escape").exists());
        assert!(!moved.join("escape").exists());

        fs::remove_file(root).expect("remove replacement symlink");
        fs::remove_dir_all(moved).expect("remove moved workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[cfg(unix)]
    #[test]
    fn directory_creation_does_not_remove_an_uncertain_result() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("directory-result-race");
        let displaced = root.join("created-displaced");
        let outside = unique_temp_dir("directory-result-outside");
        fs::create_dir_all(&root).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside");
        let state = workspace_state(&root);

        let result = create_directory_with_hooks(
            &state,
            &root,
            "created",
            || {},
            |phase| {
                if phase == DirectoryCreateHookPhase::AfterCreate {
                    fs::rename(root.join("created"), &displaced).expect("displace result");
                    symlink(&outside, root.join("created")).expect("replace result");
                }
            },
        );

        assert_eq!(result.unwrap_err(), "CREATE_DIRECTORY_RESULT_UNCERTAIN");
        assert!(
            displaced.is_dir(),
            "created directory must not be auto-deleted"
        );
        assert!(
            outside.is_dir(),
            "external replacement must remain untouched"
        );

        fs::remove_file(root.join("created")).expect("remove replacement symlink");
        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[test]
    fn workspace_registry_isolates_directory_creation_by_window_root() {
        let root_a = unique_temp_dir("create-directory-window-a");
        let root_b = unique_temp_dir("create-directory-window-b");
        fs::create_dir_all(&root_a).expect("create root a");
        fs::create_dir_all(&root_b).expect("create root b");
        let registry = WorkspaceRegistry::default();
        let state_a = registry.workspace_for_label("window-a").expect("state a");
        let state_b = registry.workspace_for_label("window-b").expect("state b");
        set_workspace_root_impl(&state_a, &root_a).expect("bind a");
        set_workspace_root_impl(&state_b, &root_b).expect("bind b");

        create_directory_impl(&state_a, &root_a, "only-a").expect("create in a");
        create_directory_impl(&state_b, &root_b, "only-b").expect("create in b");
        assert!(create_directory_impl(&state_a, &root_b, "escape").is_err());
        assert!(create_directory_impl(&state_b, &root_a, "escape").is_err());
        assert!(root_a.join("only-a").is_dir());
        assert!(!root_a.join("only-b").exists());
        assert!(root_b.join("only-b").is_dir());
        assert!(!root_b.join("only-a").exists());

        fs::remove_dir_all(root_a).expect("remove root a");
        fs::remove_dir_all(root_b).expect("remove root b");
    }

    #[test]
    fn recognizes_required_file_kinds() {
        assert_eq!(file_kind(Path::new("notes.markdown"), false), "md");
        assert_eq!(file_kind(Path::new("index.htm"), false), "html");
        assert_eq!(file_kind(Path::new("cover.webp"), false), "image");
        assert_eq!(file_kind(Path::new("sheet.xlsx"), false), "spreadsheet");
        assert_eq!(file_kind(Path::new("folder"), true), "folder");
    }

    #[test]
    fn recognizes_iwork_document_bundles() {
        assert_eq!(file_kind(Path::new("Budget.numbers"), true), "spreadsheet");
        assert_eq!(file_kind(Path::new("Draft.pages"), true), "document");
        assert_eq!(file_kind(Path::new("Pitch.key"), true), "presentation");
        assert_eq!(file_kind(Path::new("ordinary"), true), "folder");
    }

    #[test]
    fn ordinary_directories_with_non_iwork_extensions_remain_folders() {
        for name in [
            "archive.xls",
            "archive.xlsx",
            "archive.ods",
            "draft.doc",
            "draft.docx",
            "draft.odt",
            "draft.rtf",
            "deck.ppt",
            "deck.pptx",
            "deck.odp",
            "report.pdf",
            "cover.png",
        ] {
            assert_eq!(file_kind(Path::new(name), true), "folder", "{name}");
        }
    }

    #[test]
    fn macos_file_associations_exactly_cover_supported_extensions() {
        let groups: &[(&[&str], &str, &str)] = &[
            (MARKDOWN_EXTENSIONS, "md", "Editor"),
            (HTML_EXTENSIONS, "html", "Editor"),
            (TEXT_EXTENSIONS, "text", "Editor"),
            (IMAGE_EXTENSIONS, "image", "Viewer"),
            (PDF_EXTENSIONS, "pdf", "Viewer"),
            (SPREADSHEET_EXTENSIONS, "spreadsheet", "Viewer"),
            (DOCUMENT_EXTENSIONS, "document", "Viewer"),
            (PRESENTATION_EXTENSIONS, "presentation", "Viewer"),
        ];
        let mut expected = BTreeMap::<String, String>::new();

        for (extensions, kind, role) in groups {
            for extension in *extensions {
                assert_eq!(file_kind_from_extension(extension), *kind, "{extension}");
                assert!(
                    expected
                        .insert((*extension).to_string(), (*role).to_string())
                        .is_none(),
                    "duplicate supported extension: {extension}"
                );
            }
        }

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("parse tauri config");
        let associations = config["bundle"]["fileAssociations"]
            .as_array()
            .expect("bundle.fileAssociations array");
        let mut actual = BTreeMap::<String, String>::new();

        for association in associations {
            let role = association["role"].as_str().expect("association role");
            assert_eq!(
                association["rank"].as_str(),
                Some("Alternate"),
                "every supported type must remain an alternate handler"
            );
            let extensions = association["ext"]
                .as_array()
                .expect("association extensions");
            for extension in extensions {
                let extension = extension.as_str().expect("extension string");
                assert!(
                    actual
                        .insert(extension.to_string(), role.to_string())
                        .is_none(),
                    "duplicate configured extension: {extension}"
                );
            }
        }

        assert_eq!(actual, expected);
        assert_eq!(actual.len(), 46);
        assert_eq!(actual.get("csv").map(String::as_str), Some("Viewer"));
        let csv_association = associations
            .iter()
            .find(|association| {
                association["ext"]
                    .as_array()
                    .is_some_and(|extensions| extensions.iter().any(|value| value == "csv"))
            })
            .expect("CSV file association");
        assert!(csv_association["contentTypes"]
            .as_array()
            .is_some_and(|content_types| content_types
                .iter()
                .any(|value| value == "public.comma-separated-values-text")));
    }

    #[test]
    fn workspace_windows_can_destroy_after_the_frontend_save_guard() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("parse default capability");
        assert_eq!(
            capability["windows"],
            serde_json::json!(["main", "workspace-*"])
        );
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability permissions");
        assert!(permissions
            .iter()
            .any(|value| value == "core:window:allow-destroy"));
        assert!(!permissions
            .iter()
            .any(|value| value == "core:window:allow-close"));
    }

    #[test]
    fn webview_drag_drop_handler_is_disabled_for_html5_tree_moves() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("parse tauri config");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows array");
        let template = windows.first().expect("workspace window template");

        assert_eq!(
            template["dragDropEnabled"].as_bool(),
            Some(false),
            "the shared workspace window template must leave HTML5 drag/drop to WKWebView"
        );
    }

    #[test]
    fn workspace_windows_have_native_titlebar_drag_permission() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("parse default capability");
        let windows = capability["windows"]
            .as_array()
            .expect("capability windows array");
        assert!(windows.iter().any(|window| window.as_str() == Some("main")));
        assert!(windows
            .iter()
            .any(|window| window.as_str() == Some("workspace-*")));
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability permissions array");
        assert!(permissions
            .iter()
            .any(|permission| { permission.as_str() == Some("core:window:allow-start-dragging") }));
    }

    #[test]
    fn versions_change_with_content() {
        assert_eq!(version_for_bytes(b"same"), version_for_bytes(b"same"));
        assert_ne!(version_for_bytes(b"same"), version_for_bytes(b"changed"));
    }

    #[cfg(unix)]
    #[test]
    fn pinned_text_write_rejects_a_replaced_parent_without_redirecting_content() {
        let root = unique_temp_dir("text-write-parent-race");
        let parent = root.join("docs");
        let displaced_parent = root.join("docs-original");
        let target = parent.join("notes.md");
        fs::create_dir_all(&parent).expect("create original parent");
        fs::write(&target, b"original").expect("create original file");
        let state = workspace_state(&root);
        let expected_version = version_for_bytes(b"original");

        let error =
            write_text_file_with_hook(&state, &target, "local edit", &expected_version, || {
                fs::rename(&parent, &displaced_parent).expect("displace original parent");
                fs::create_dir(&parent).expect("create replacement parent");
                fs::write(parent.join("notes.md"), b"replacement")
                    .expect("create replacement file");
            })
            .expect_err("replaced parent must fail closed");

        assert_eq!(error.code, "WORKSPACE_CHANGED");
        assert_eq!(
            fs::read(displaced_parent.join("notes.md")).expect("read original identity"),
            b"original"
        );
        assert_eq!(
            fs::read(parent.join("notes.md")).expect("read replacement identity"),
            b"replacement"
        );
        assert!(fs::read_dir(&displaced_parent)
            .expect("list displaced parent")
            .all(|entry| !entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".localview-")));

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn finds_nearest_project_marker() {
        let unique = format!(
            "localview-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let nested = root.join("docs").join("drafts");
        fs::create_dir_all(&nested).expect("create test directories");
        fs::write(root.join("package.json"), b"{}").expect("create project marker");
        let file = nested.join("plan.md");
        fs::write(&file, b"# Plan").expect("create test file");

        let found = find_workspace_root(file.to_string_lossy().into_owned()).expect("find root");
        assert_eq!(
            PathBuf::from(found),
            fs::canonicalize(&root).expect("canonical root")
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn uses_iwork_bundle_parent_as_workspace_fallback() {
        let unique = format!(
            "localview-bundle-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let numbers = root.join("Budget.numbers");
        let pages = root.join("Draft.pages");
        let keynote = root.join("Pitch.key");
        fs::create_dir_all(&numbers).expect("create Numbers bundle");
        fs::create_dir_all(&pages).expect("create Pages bundle");
        fs::create_dir_all(&keynote).expect("create Keynote bundle");

        for bundle in [&numbers, &pages, &keynote] {
            let found = find_workspace_root(bundle.to_string_lossy().into_owned())
                .expect("find bundle workspace root");
            assert_eq!(
                PathBuf::from(found),
                fs::canonicalize(&root).expect("canonical bundle parent")
            );
        }

        let ordinary = root.join("ordinary");
        fs::create_dir_all(&ordinary).expect("create ordinary directory");
        let found = find_workspace_root(ordinary.to_string_lossy().into_owned())
            .expect("find ordinary directory workspace root");
        assert_eq!(
            PathBuf::from(found),
            fs::canonicalize(&ordinary).expect("canonical ordinary directory")
        );

        fs::remove_dir_all(root).expect("remove bundle test directory");
    }

    #[test]
    fn workspace_generations_are_monotonic() {
        let root = unique_temp_dir("workspace-generation");
        fs::create_dir_all(&root).expect("create workspace");
        let state = WorkspaceState::default();
        let first = set_workspace_root_impl(&state, &root).expect("first workspace binding");
        let second = set_workspace_root_impl(&state, &root).expect("second workspace binding");
        assert!(second.generation > first.generation);
        assert!(!first.watching && !second.watching);
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn superseded_workspace_candidate_cannot_replace_newer_context() {
        let first_root = unique_temp_dir("workspace-generation-first");
        let newer_root = unique_temp_dir("workspace-generation-newer");
        let stale_root = unique_temp_dir("workspace-generation-stale");
        for path in [&first_root, &newer_root, &stale_root] {
            fs::create_dir_all(path).expect("create workspace");
        }
        let state = workspace_state(&first_root);
        let newer = open_workspace_root(&newer_root).expect("open newer workspace");
        let stale = open_workspace_root(&stale_root).expect("open stale workspace");

        let binding = commit_workspace_candidate(&state, newer, None, 3)
            .expect("commit newer workspace candidate");
        assert_eq!(binding.generation, 3);
        assert_eq!(
            commit_workspace_candidate(&state, stale, None, 2).unwrap_err(),
            "WORKSPACE_ROOT_SUPERSEDED"
        );
        assert_eq!(
            active_workspace_root(&state).expect("active workspace"),
            fs::canonicalize(&newer_root).expect("canonical newer workspace")
        );

        for path in [first_root, newer_root, stale_root] {
            fs::remove_dir_all(path).expect("remove workspace");
        }
    }

    #[test]
    fn maps_watch_events_without_temp_files_or_outside_paths() {
        use notify_debouncer_full::notify::event::{CreateKind, RenameMode};

        let root = Path::new("/workspace");
        let create = map_watch_event(
            root,
            &EventKind::Create(CreateKind::File),
            &[
                PathBuf::from("/workspace/new.md"),
                PathBuf::from("/workspace/.new.md.localview-1-0.tmp"),
                PathBuf::from("/outside/no.md"),
            ],
            false,
        )
        .expect("mapped create event");
        assert_eq!(create.kind, WorkspaceFsEventKind::Create);
        assert_eq!(create.paths, vec!["/workspace/new.md"]);

        let rename = map_watch_event(
            root,
            &EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[
                PathBuf::from("/workspace/old.md"),
                PathBuf::from("/workspace/new.md"),
            ],
            false,
        )
        .expect("mapped paired rename");
        assert_eq!(rename.kind, WorkspaceFsEventKind::Rename);
        assert_eq!(rename.paths.len(), 2);

        let rescan = map_watch_event(root, &EventKind::Other, &[], true).expect("mapped rescan");
        assert_eq!(rescan.kind, WorkspaceFsEventKind::Rescan);
    }

    #[cfg(unix)]
    #[test]
    fn trash_preflight_rejects_root_symlink_and_outside_paths() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("trash-preflight");
        let outside = unique_temp_dir("trash-outside");
        fs::create_dir_all(&root).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside");
        fs::write(root.join("target.md"), b"target").expect("create target");
        symlink(root.join("target.md"), root.join("link.md")).expect("create symlink");
        fs::write(outside.join("outside.md"), b"outside").expect("create outside target");
        let state = workspace_state(&root);

        assert_eq!(
            trash_preflight(&state, &root).unwrap_err(),
            "TRASH_ROOT_FORBIDDEN"
        );
        assert_eq!(
            trash_preflight(&state, &root.join("link.md")).unwrap_err(),
            "TRASH_SYMLINK_UNSUPPORTED"
        );
        assert_eq!(
            trash_preflight(&state, &outside.join("outside.md")).unwrap_err(),
            "Path is outside the active workspace"
        );

        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[cfg(unix)]
    #[test]
    fn trash_candidate_rejects_identity_and_generation_changes() {
        let root = unique_temp_dir("trash-candidate-race");
        fs::create_dir_all(&root).expect("create workspace");
        let target = root.join("target.md");
        let old_target = root.join("target-old.md");
        fs::write(&target, b"old").expect("create target");
        let state = workspace_state(&root);

        let candidate = trash_candidate(&trash_preflight(&state, &target).expect("preflight"));
        fs::rename(&target, &old_target).expect("retain old identity");
        fs::write(&target, b"replacement").expect("replace target path");
        assert_eq!(
            move_candidate_to_trash_impl(&state, &candidate).unwrap_err(),
            "TRASH_TARGET_CHANGED"
        );

        let candidate = trash_candidate(&trash_preflight(&state, &target).expect("new preflight"));
        state.context.lock().expect("workspace context").generation += 1;
        assert_eq!(
            move_candidate_to_trash_impl(&state, &candidate).unwrap_err(),
            "WORKSPACE_CHANGED"
        );

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_move_moves_files_directories_and_iwork_bundles_without_overwrite() {
        let root = unique_temp_dir("workspace-move-success");
        fs::create_dir_all(root.join("source")).expect("create source parent");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source_parent = root.join("source");
        let destination = root.join("destination");
        let state = workspace_state(&root);

        let file = source_parent.join("notes.md");
        fs::write(&file, b"notes").expect("create regular file");
        let candidate = prepare_workspace_move_impl(&state, &file, &destination)
            .expect("prepare regular file move");
        assert!(!candidate.source_is_directory);
        assert!(!candidate.source_is_bundle);
        let moved = move_workspace_entry_impl(&state, &candidate).expect("move regular file");
        assert_eq!(moved.original_path, file.to_string_lossy());
        assert_eq!(moved.entry.kind, "md");
        assert!(!file.exists());
        assert_eq!(fs::read(destination.join("notes.md")).unwrap(), b"notes");

        let bundle = source_parent.join("Budget.numbers");
        fs::create_dir_all(&bundle).expect("create Numbers bundle");
        fs::write(bundle.join("Index.zip"), b"bundle").expect("create bundle content");
        let candidate = prepare_workspace_move_impl(&state, &bundle, &destination)
            .expect("prepare bundle move");
        assert!(candidate.source_is_directory);
        assert!(candidate.source_is_bundle);
        let moved = move_workspace_entry_impl(&state, &candidate).expect("move bundle");
        assert_eq!(moved.entry.kind, "spreadsheet");
        assert!(!bundle.exists());
        assert!(destination.join("Budget.numbers/Index.zip").exists());

        let folder = source_parent.join("ordinary-folder");
        fs::create_dir_all(folder.join("nested")).expect("create ordinary folder");
        fs::write(folder.join("nested/child.md"), b"child").expect("create nested child");
        let candidate = prepare_workspace_move_impl(&state, &folder, &destination)
            .expect("prepare ordinary directory move");
        assert!(candidate.source_is_directory);
        assert!(!candidate.source_is_bundle);
        let moved = move_workspace_entry_impl(&state, &candidate).expect("move directory");
        assert_eq!(moved.entry.kind, "folder");
        assert!(!folder.exists());
        let moved_folder = destination.join("ordinary-folder");
        assert!(moved_folder.join("nested/child.md").exists());

        let candidate = prepare_workspace_move_impl(&state, &moved_folder, &root)
            .expect("prepare directory move to root");
        assert_eq!(
            reconcile_workspace_move_impl(&state, &candidate)
                .expect("folder source reconciliation")
                .outcome,
            MoveReconciliationOutcome::Source
        );
        move_workspace_entry_impl(&state, &candidate).expect("move directory to root");
        let reconciled = reconcile_workspace_move_impl(&state, &candidate)
            .expect("folder destination reconciliation");
        assert_eq!(reconciled.outcome, MoveReconciliationOutcome::Destination);
        assert_eq!(reconciled.entry.expect("moved folder entry").kind, "folder");
        assert!(root.join("ordinary-folder/nested/child.md").exists());

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_move_rejects_root_descendant_symlink_outside_same_parent_and_collision() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("workspace-move-rejections");
        let outside = unique_temp_dir("workspace-move-outside");
        fs::create_dir_all(root.join("source")).expect("create source parent");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        fs::create_dir_all(&outside).expect("create outside");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let outside = fs::canonicalize(outside).expect("canonical outside");
        let source_parent = root.join("source");
        let destination = root.join("destination");
        let file = source_parent.join("notes.md");
        fs::write(&file, b"notes").expect("create file");
        let ordinary_folder = source_parent.join("ordinary-folder");
        fs::create_dir_all(ordinary_folder.join("child")).expect("create folder descendants");
        symlink(&file, source_parent.join("notes-link.md")).expect("create symlink");
        fs::write(outside.join("outside.md"), b"outside").expect("create outside file");
        let state = workspace_state(&root);

        assert_eq!(
            prepare_workspace_move_impl(&state, &root, &destination)
                .unwrap_err()
                .code,
            "MOVE_SOURCE_UNSUPPORTED"
        );
        assert_eq!(
            prepare_workspace_move_impl(&state, &ordinary_folder, &ordinary_folder)
                .unwrap_err()
                .code,
            "MOVE_DESTINATION_INSIDE_SOURCE"
        );
        assert_eq!(
            prepare_workspace_move_impl(&state, &ordinary_folder, &ordinary_folder.join("child"),)
                .unwrap_err()
                .code,
            "MOVE_DESTINATION_INSIDE_SOURCE"
        );
        assert_eq!(
            prepare_workspace_move_impl(
                &state,
                &source_parent.join("notes-link.md"),
                &destination,
            )
            .unwrap_err()
            .code,
            "MOVE_SOURCE_UNSUPPORTED"
        );
        assert_eq!(
            prepare_workspace_move_impl(&state, &outside.join("outside.md"), &destination)
                .unwrap_err()
                .code,
            "WORKSPACE_CHANGED"
        );
        assert_eq!(
            prepare_workspace_move_impl(&state, &file, &source_parent)
                .unwrap_err()
                .code,
            "MOVE_SAME_PARENT"
        );
        fs::write(destination.join("notes.md"), b"existing").expect("create collision");
        assert_eq!(
            prepare_workspace_move_impl(&state, &file, &destination)
                .unwrap_err()
                .code,
            "MOVE_DESTINATION_EXISTS"
        );

        fs::remove_dir_all(root).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_move_rejects_iwork_bundle_interior_boundaries() {
        let root = unique_temp_dir("workspace-move-bundle-boundary");
        let bundle = root.join("Budget.numbers");
        let destination = root.join("destination");
        fs::create_dir_all(&bundle).expect("create bundle");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(bundle.join("Index.zip"), b"bundle").expect("create bundle content");
        fs::write(root.join("notes.md"), b"notes").expect("create ordinary file");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let bundle = root.join("Budget.numbers");
        let destination = root.join("destination");
        let state = workspace_state(&root);

        assert_eq!(
            prepare_workspace_move_impl(&state, &bundle.join("Index.zip"), &destination)
                .unwrap_err()
                .code,
            "MOVE_BUNDLE_BOUNDARY"
        );
        assert_eq!(
            prepare_workspace_move_impl(&state, &root.join("notes.md"), &bundle)
                .unwrap_err()
                .code,
            "MOVE_BUNDLE_BOUNDARY"
        );
        assert!(prepare_workspace_move_impl(&state, &bundle, &destination).is_ok());

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_move_rolls_back_parent_and_leaf_replacements_without_outside_writes() {
        for race in ["destination-parent", "source-parent", "source-leaf"] {
            let root = unique_temp_dir(&format!("workspace-move-{race}"));
            let outside = unique_temp_dir(&format!("workspace-move-{race}-outside"));
            fs::create_dir_all(root.join("source")).expect("create source");
            fs::create_dir_all(root.join("destination")).expect("create destination");
            fs::create_dir_all(&outside).expect("create outside");
            let root = fs::canonicalize(root).expect("canonical workspace");
            let source = root.join("source/notes.md");
            let destination = root.join("destination");
            fs::write(&source, b"prepared").expect("create source file");
            let state = workspace_state(&root);
            let candidate =
                prepare_workspace_move_impl(&state, &source, &destination).expect("prepare move");
            let displaced_source = root.join("source-original");
            let displaced_destination = outside.join("destination-original");
            let retained_leaf = root.join("source/prepared-notes.md");

            let result = move_workspace_entry_with_hook(&state, &candidate, |phase| {
                if phase != MoveCommitPhase::AfterFinalPreflight {
                    return;
                }
                match race {
                    "destination-parent" => {
                        fs::rename(&destination, &displaced_destination)
                            .expect("displace destination");
                        fs::create_dir(&destination).expect("replace destination");
                    }
                    "source-parent" => {
                        fs::rename(root.join("source"), &displaced_source)
                            .expect("displace source parent");
                        fs::create_dir(root.join("source")).expect("replace source parent");
                        fs::write(&source, b"replacement-parent")
                            .expect("create replacement source");
                    }
                    "source-leaf" => {
                        fs::rename(&source, &retained_leaf).expect("retain prepared leaf");
                        fs::write(&source, b"replacement-leaf").expect("create replacement leaf");
                    }
                    _ => unreachable!(),
                }
            })
            .unwrap_err();

            assert!(matches!(
                result.code.as_str(),
                "MOVE_SOURCE_CHANGED" | "MOVE_DESTINATION_CHANGED"
            ));
            assert!(!destination.join("notes.md").exists());
            match race {
                "destination-parent" => {
                    assert_eq!(fs::read(&source).unwrap(), b"prepared");
                    assert!(!displaced_destination.join("notes.md").exists());
                }
                "source-parent" => {
                    assert_eq!(fs::read(&source).unwrap(), b"replacement-parent");
                    assert_eq!(
                        fs::read(displaced_source.join("notes.md")).unwrap(),
                        b"prepared"
                    );
                }
                "source-leaf" => {
                    assert_eq!(fs::read(&source).unwrap(), b"replacement-leaf");
                    assert_eq!(fs::read(&retained_leaf).unwrap(), b"prepared");
                }
                _ => unreachable!(),
            }
            fs::remove_dir_all(&root).expect("remove workspace");
            fs::remove_dir_all(&outside).expect("remove outside");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_move_reports_uncertain_without_overwriting_a_rollback_collision() {
        let root = unique_temp_dir("workspace-move-rollback-collision");
        fs::create_dir_all(root.join("source")).expect("create source");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source = root.join("source/notes.md");
        let retained = root.join("source/prepared.md");
        let destination = root.join("destination");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_move_impl(&state, &source, &destination).expect("prepare move");

        let result = move_workspace_entry_with_hook(&state, &candidate, |phase| match phase {
            MoveCommitPhase::AfterFinalPreflight => {
                fs::rename(&source, &retained).expect("retain prepared source");
                fs::write(&source, b"replacement").expect("create replacement source");
            }
            MoveCommitPhase::BeforeRollback => {
                fs::write(&source, b"external-collision").expect("create rollback collision");
            }
            MoveCommitPhase::AfterRename => {}
        })
        .unwrap_err();

        assert_eq!(result.code, "MOVE_OUTCOME_UNCERTAIN");
        assert_eq!(fs::read(&source).unwrap(), b"external-collision");
        assert_eq!(
            fs::read(destination.join("notes.md")).unwrap(),
            b"replacement"
        );
        assert_eq!(fs::read(&retained).unwrap(), b"prepared");
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_move_reports_uncertain_when_root_path_changes_after_rename() {
        let root = unique_temp_dir("workspace-move-root-post-race");
        fs::create_dir_all(root.join("source")).expect("create source");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let old_root = root.with_extension("displaced");
        let source = root.join("source/notes.md");
        let destination = root.join("destination");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_move_impl(&state, &source, &destination).expect("prepare move");

        let result = move_workspace_entry_with_hook(&state, &candidate, |phase| {
            if phase == MoveCommitPhase::AfterRename {
                fs::rename(&root, &old_root).expect("displace workspace root");
                fs::create_dir(&root).expect("replace workspace root");
            }
        })
        .unwrap_err();

        assert_eq!(result.code, "MOVE_OUTCOME_UNCERTAIN");
        assert!(!root.join("destination/notes.md").exists());
        assert_eq!(
            fs::read(old_root.join("destination/notes.md")).unwrap(),
            b"prepared"
        );
        drop(state);
        fs::remove_dir_all(root).expect("remove replacement root");
        fs::remove_dir_all(old_root).expect("remove displaced root");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_move_revalidates_source_destination_root_and_generation() {
        let root = unique_temp_dir("workspace-move-races");
        fs::create_dir_all(root.join("source")).expect("create source parent");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source_parent = root.join("source");
        let destination = root.join("destination");
        let file = source_parent.join("notes.md");
        fs::write(&file, b"old").expect("create file");
        let state = workspace_state(&root);

        let candidate =
            prepare_workspace_move_impl(&state, &file, &destination).expect("prepare source race");
        fs::rename(&file, source_parent.join("old-notes.md")).expect("retain old source");
        fs::write(&file, b"replacement").expect("replace source");
        assert_eq!(
            move_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "MOVE_SOURCE_CHANGED"
        );

        let candidate = prepare_workspace_move_impl(&state, &file, &destination)
            .expect("prepare source parent race");
        let old_source_parent = root.join("source-old-parent");
        fs::rename(&source_parent, &old_source_parent).expect("retain old source parent");
        fs::create_dir(&source_parent).expect("replace source parent");
        fs::write(&file, b"new parent file").expect("replace source in new parent");
        assert_eq!(
            move_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "MOVE_SOURCE_CHANGED"
        );

        let candidate = prepare_workspace_move_impl(&state, &file, &destination)
            .expect("prepare destination race");
        let old_destination = root.join("destination-old");
        fs::rename(&destination, &old_destination).expect("retain old destination");
        fs::create_dir(&destination).expect("replace destination");
        assert_eq!(
            move_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "MOVE_DESTINATION_CHANGED"
        );

        let candidate = prepare_workspace_move_impl(&state, &file, &destination)
            .expect("prepare generation race");
        state.context.lock().expect("workspace context").generation += 1;
        assert_eq!(
            move_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "WORKSPACE_CHANGED"
        );

        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_move_impl(&state, &file, &destination).expect("prepare root race");
        let old_root = root.with_extension("old-root");
        fs::rename(&root, &old_root).expect("retain pinned root");
        fs::create_dir(&root).expect("replace root path");
        assert_eq!(
            move_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "WORKSPACE_CHANGED"
        );
        drop(state);
        fs::remove_dir_all(root).expect("remove replacement root");
        fs::remove_dir_all(old_root).expect("remove old root");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_move_reconciliation_reports_source_destination_and_ambiguous() {
        let root = unique_temp_dir("workspace-move-reconcile");
        fs::create_dir_all(root.join("source")).expect("create source parent");
        fs::create_dir_all(root.join("destination")).expect("create destination");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source_parent = root.join("source");
        let destination = root.join("destination");
        let file = source_parent.join("notes.md");
        fs::write(&file, b"notes").expect("create file");
        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_move_impl(&state, &file, &destination).expect("prepare move");

        assert_eq!(
            reconcile_workspace_move_impl(&state, &candidate)
                .expect("source outcome")
                .outcome,
            MoveReconciliationOutcome::Source
        );
        move_workspace_entry_impl(&state, &candidate).expect("move file");
        let reconciled =
            reconcile_workspace_move_impl(&state, &candidate).expect("destination outcome");
        assert_eq!(reconciled.outcome, MoveReconciliationOutcome::Destination);
        assert_eq!(reconciled.entry.unwrap().path, candidate.destination_path);

        let second = source_parent.join("second.md");
        fs::write(&second, b"second").expect("create second file");
        let candidate = prepare_workspace_move_impl(&state, &second, &destination)
            .expect("prepare ambiguous move");
        fs::hard_link(&second, destination.join("second.md")).expect("duplicate identity");
        assert_eq!(
            reconcile_workspace_move_impl(&state, &candidate)
                .expect("ambiguous outcome")
                .outcome,
            MoveReconciliationOutcome::Ambiguous
        );

        assert_eq!(
            move_rename_error(Errno::XDEV).code,
            "MOVE_CROSS_DEVICE_UNSUPPORTED"
        );
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_rename_validates_names_with_the_frontend_contract() {
        assert_eq!(
            validate_workspace_rename_name("notes.md", "  会议记录.md  ", false, false)
                .expect("unicode trim"),
            "会议记录.md"
        );
        assert_eq!(
            validate_workspace_rename_name(".env", ".config", false, false).expect("dotfile"),
            ".config"
        );
        assert_eq!(
            validate_workspace_rename_name("archive.tar.gz", "backup.tar.gz", false, false)
                .expect("multi extension"),
            "backup.tar.gz"
        );
        for (name, code) in [
            ("", "RENAME_INVALID_NAME"),
            ("..", "RENAME_INVALID_NAME"),
            ("a/b.md", "RENAME_INVALID_NAME"),
            (".DS_Store", "RENAME_RESERVED_NAME"),
            (".localview-save.tmp", "RENAME_RESERVED_NAME"),
            ("README.txt", "RENAME_EXTENSION_CHANGE_UNSUPPORTED"),
        ] {
            assert_eq!(
                validate_workspace_rename_name("README", name, false, false)
                    .unwrap_err()
                    .code,
                code
            );
        }
        assert_eq!(
            validate_workspace_rename_name("notes.md", "notes.md", false, false)
                .unwrap_err()
                .code,
            "RENAME_UNCHANGED"
        );
        assert_eq!(
            validate_workspace_rename_name("notes.md", "NOTES.md", false, false)
                .unwrap_err()
                .code,
            "RENAME_CASE_ONLY_UNSUPPORTED"
        );
        assert_eq!(
            validate_workspace_rename_name(
                "notes.md",
                &format!("{}.md", "😀".repeat(127)),
                false,
                false,
            )
            .unwrap_err()
            .code,
            "RENAME_NAME_TOO_LONG"
        );
        assert_eq!(
            validate_workspace_rename_name("docs", "Budget.numbers", true, false)
                .unwrap_err()
                .code,
            "RENAME_RESERVED_NAME"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_rename_renames_files_directories_and_whole_iwork_bundles() {
        let root = unique_temp_dir("workspace-rename-success");
        fs::create_dir_all(&root).expect("create workspace");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let state = workspace_state(&root);

        let file = root.join("notes.md");
        fs::write(&file, b"notes").expect("create file");
        let candidate = prepare_workspace_rename_impl(&state, &file, "journal.md")
            .expect("prepare file rename");
        assert_eq!(
            reconcile_workspace_rename_impl(&state, &candidate)
                .expect("source reconciliation")
                .outcome,
            RenameReconciliationOutcome::Source
        );
        let renamed = rename_workspace_entry_impl(&state, &candidate).expect("rename file");
        assert_eq!(renamed.entry.kind, "md");
        assert_eq!(fs::read(root.join("journal.md")).unwrap(), b"notes");
        let reconciled = reconcile_workspace_rename_impl(&state, &candidate)
            .expect("destination reconciliation");
        assert_eq!(reconciled.outcome, RenameReconciliationOutcome::Destination);
        assert_eq!(reconciled.entry.unwrap().path, candidate.destination_path);

        let folder = root.join("drafts");
        fs::create_dir_all(folder.join("nested")).expect("create folder");
        fs::write(folder.join("nested/child.md"), b"child").expect("create child");
        let candidate = prepare_workspace_rename_impl(&state, &folder, "archive")
            .expect("prepare folder rename");
        rename_workspace_entry_impl(&state, &candidate).expect("rename folder");
        assert_eq!(
            fs::read(root.join("archive/nested/child.md")).unwrap(),
            b"child"
        );

        let bundle = root.join("Budget.numbers");
        fs::create_dir_all(&bundle).expect("create bundle");
        fs::write(bundle.join("Index.zip"), b"bundle").expect("create bundle content");
        let candidate = prepare_workspace_rename_impl(&state, &bundle, "Forecast.numbers")
            .expect("prepare bundle rename");
        assert!(candidate.source_is_bundle);
        let renamed = rename_workspace_entry_impl(&state, &candidate).expect("rename bundle");
        assert_eq!(renamed.entry.kind, "spreadsheet");
        assert!(root.join("Forecast.numbers/Index.zip").exists());

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_rename_rejects_root_symlink_bundle_interior_collision_and_invalid_names() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("workspace-rename-rejections");
        fs::create_dir_all(root.join("Budget.numbers")).expect("create bundle");
        fs::write(root.join("Budget.numbers/Index.zip"), b"bundle").expect("create bundle content");
        fs::write(root.join("notes.md"), b"notes").expect("create file");
        fs::write(root.join("taken.md"), b"taken").expect("create collision");
        symlink(root.join("notes.md"), root.join("notes-link.md")).expect("create symlink");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let state = workspace_state(&root);

        assert_eq!(
            prepare_workspace_rename_impl(&state, &root, "renamed")
                .unwrap_err()
                .code,
            "RENAME_ROOT_FORBIDDEN"
        );
        assert_eq!(
            prepare_workspace_rename_impl(&state, &root.join("notes-link.md"), "link-2.md")
                .unwrap_err()
                .code,
            "RENAME_SOURCE_UNSUPPORTED"
        );
        assert_eq!(
            prepare_workspace_rename_impl(
                &state,
                &root.join("Budget.numbers/Index.zip"),
                "Other.zip",
            )
            .unwrap_err()
            .code,
            "RENAME_BUNDLE_BOUNDARY"
        );
        assert_eq!(
            prepare_workspace_rename_impl(&state, &root.join("notes.md"), "taken.md")
                .unwrap_err()
                .code,
            "RENAME_DESTINATION_EXISTS"
        );
        assert_eq!(
            prepare_workspace_rename_impl(&state, &root.join("notes.md"), "notes.txt")
                .unwrap_err()
                .code,
            "RENAME_EXTENSION_CHANGE_UNSUPPORTED"
        );
        assert_eq!(
            prepare_workspace_rename_impl(&state, &root.join("notes.md"), "NOTES.md")
                .unwrap_err()
                .code,
            "RENAME_CASE_ONLY_UNSUPPORTED"
        );

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_rename_revalidates_candidate_and_never_overwrites_a_late_collision() {
        let root = unique_temp_dir("workspace-rename-revalidate");
        fs::create_dir_all(&root).expect("create workspace");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source = root.join("notes.md");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);

        let mut tampered = prepare_workspace_rename_impl(&state, &source, "journal.md")
            .expect("prepare tampered rename");
        tampered.destination_path = root.join("journal.txt").to_string_lossy().into_owned();
        assert_eq!(
            rename_workspace_entry_impl(&state, &tampered)
                .unwrap_err()
                .code,
            "RENAME_EXTENSION_CHANGE_UNSUPPORTED"
        );

        let candidate = prepare_workspace_rename_impl(&state, &source, "journal.md")
            .expect("prepare collision rename");
        let result = rename_workspace_entry_with_hook(&state, &candidate, |phase| {
            if phase == MoveCommitPhase::AfterFinalPreflight {
                fs::write(root.join("journal.md"), b"external").expect("create late collision");
            }
        })
        .unwrap_err();
        assert_eq!(result.code, "RENAME_DESTINATION_EXISTS");
        assert_eq!(fs::read(&source).unwrap(), b"prepared");
        assert_eq!(fs::read(root.join("journal.md")).unwrap(), b"external");

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_rename_reports_uncertain_without_false_success_after_source_replacement() {
        let root = unique_temp_dir("workspace-rename-source-race");
        fs::create_dir_all(&root).expect("create workspace");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source = root.join("notes.md");
        let retained = root.join("prepared.md");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_rename_impl(&state, &source, "journal.md").expect("prepare rename");

        let result = rename_workspace_entry_with_hook(&state, &candidate, |phase| {
            if phase == MoveCommitPhase::AfterFinalPreflight {
                fs::rename(&source, &retained).expect("retain prepared source");
                fs::write(&source, b"replacement").expect("create replacement source");
            }
        })
        .unwrap_err();
        assert_eq!(result.code, "RENAME_OUTCOME_UNCERTAIN");
        assert_eq!(fs::read(&retained).unwrap(), b"prepared");
        assert_eq!(fs::read(root.join("journal.md")).unwrap(), b"replacement");
        assert!(!source.exists());

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_rename_revalidates_source_generation_and_parent_identity() {
        let root = unique_temp_dir("workspace-rename-races");
        fs::create_dir_all(root.join("parent")).expect("create parent");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source = root.join("parent/notes.md");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);

        let candidate = prepare_workspace_rename_impl(&state, &source, "journal.md")
            .expect("prepare source race");
        fs::rename(&source, root.join("parent/prepared.md")).expect("retain source");
        fs::write(&source, b"replacement").expect("replace source");
        assert_eq!(
            rename_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "RENAME_SOURCE_CHANGED"
        );

        let candidate = prepare_workspace_rename_impl(&state, &source, "journal.md")
            .expect("prepare generation race");
        state.context.lock().expect("workspace context").generation += 1;
        assert_eq!(
            rename_workspace_entry_impl(&state, &candidate)
                .unwrap_err()
                .code,
            "WORKSPACE_CHANGED"
        );

        let state = workspace_state(&root);
        let candidate = prepare_workspace_rename_impl(&state, &source, "journal.md")
            .expect("prepare parent race");
        let displaced_parent = root.join("parent-original");
        let result = rename_workspace_entry_with_hook(&state, &candidate, |phase| {
            if phase != MoveCommitPhase::AfterFinalPreflight {
                return;
            }
            fs::rename(root.join("parent"), &displaced_parent).expect("displace parent");
            fs::create_dir(root.join("parent")).expect("replace parent");
            fs::write(&source, b"replacement-parent").expect("create replacement source");
        })
        .unwrap_err();
        assert_eq!(result.code, "RENAME_OUTCOME_UNCERTAIN");
        assert_eq!(
            fs::read(displaced_parent.join("notes.md")).unwrap(),
            b"replacement"
        );
        assert_eq!(
            fs::read(root.join("parent/journal.md")).unwrap(),
            b"replacement-parent"
        );

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_rename_preserves_a_recreated_source_and_reports_uncertain() {
        let root = unique_temp_dir("workspace-rename-rollback-collision");
        fs::create_dir_all(&root).expect("create workspace");
        let root = fs::canonicalize(root).expect("canonical workspace");
        let source = root.join("notes.md");
        fs::write(&source, b"prepared").expect("create source");
        let state = workspace_state(&root);
        let candidate =
            prepare_workspace_rename_impl(&state, &source, "journal.md").expect("prepare rename");

        let result = rename_workspace_entry_with_hook(&state, &candidate, |phase| {
            if phase == MoveCommitPhase::AfterRename {
                fs::write(&source, b"external-collision").expect("recreate source");
            }
        })
        .unwrap_err();
        assert_eq!(result.code, "RENAME_OUTCOME_UNCERTAIN");
        assert_eq!(fs::read(&source).unwrap(), b"external-collision");
        assert_eq!(fs::read(root.join("journal.md")).unwrap(), b"prepared");

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn local_asset_protocol_has_no_wildcard_cors_and_html_has_a_blocking_csp() {
        let root = unique_temp_dir("preview-protocol");
        fs::create_dir_all(&root).expect("create workspace");
        let document = root.join("index.html");
        fs::write(&document, b"<html><body>preview</body></html>").expect("write html");
        let state = workspace_state(&root);
        let preview_state = PreviewState::default();
        preview_state
            .capabilities
            .lock()
            .expect("preview capabilities")
            .insert(
                "test-token".to_string(),
                PreviewCapability {
                    window_label: "window-a".to_string(),
                    root: fs::canonicalize(&root).expect("canonical root"),
                    document: fs::canonicalize(&document).expect("canonical document"),
                    workspace_generation: 1,
                },
            );

        let response = local_asset_response(
            &state,
            &preview_state,
            "window-a",
            "/preview/test-token/index.html",
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("html CSP")
            .to_str()
            .expect("CSP text");
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("form-action 'none'"));

        let denied = local_asset_response(
            &state,
            &preview_state,
            "window-a",
            "/preview/wrong-token/index.html",
        );
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn html_preview_capability_is_owned_and_released_by_one_window() {
        let root = unique_temp_dir("preview-window-owner");
        fs::create_dir_all(&root).expect("create workspace");
        let document = root.join("index.html");
        fs::write(&document, b"<html>owned</html>").expect("write html");
        let state = workspace_state(&root);
        let preview_state = PreviewState::default();
        preview_state
            .capabilities
            .lock()
            .expect("preview capabilities")
            .insert(
                "owned-token".to_string(),
                PreviewCapability {
                    window_label: "window-a".to_string(),
                    root: fs::canonicalize(&root).unwrap(),
                    document: fs::canonicalize(&document).unwrap(),
                    workspace_generation: 1,
                },
            );

        assert_eq!(
            local_asset_response(
                &state,
                &preview_state,
                "window-b",
                "/preview/owned-token/index.html",
            )
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            release_html_preview_for_label("owned-token", "window-b", &preview_state)
                .unwrap_err()
                .code,
            "WORKSPACE_CHANGED"
        );
        assert!(preview_state
            .capabilities
            .lock()
            .unwrap()
            .contains_key("owned-token"));
        release_html_preview_for_label("owned-token", "window-a", &preview_state)
            .expect("owner releases capability");
        assert!(preview_state.capabilities.lock().unwrap().is_empty());
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn workspace_registry_isolates_roots_and_rejects_destroyed_labels() {
        let root_a = unique_temp_dir("registry-a");
        let root_b = unique_temp_dir("registry-b");
        fs::create_dir_all(&root_a).expect("create root a");
        fs::create_dir_all(&root_b).expect("create root b");
        fs::write(root_a.join("same.txt"), b"a").expect("write a");
        fs::write(root_b.join("same.txt"), b"b").expect("write b");

        let registry = WorkspaceRegistry::default();
        let state_a = registry.workspace_for_label("window-a").expect("state a");
        let state_b = registry.workspace_for_label("window-b").expect("state b");
        set_workspace_root_impl(&state_a, &root_a).expect("bind a");
        set_workspace_root_impl(&state_b, &root_b).expect("bind b");
        assert_eq!(
            fs::read(scoped_existing_path(&state_a, root_a.join("same.txt")).unwrap()).unwrap(),
            b"a"
        );
        assert_eq!(
            fs::read(scoped_existing_path(&state_b, root_b.join("same.txt")).unwrap()).unwrap(),
            b"b"
        );
        assert!(scoped_existing_path(&state_a, root_b.join("same.txt")).is_err());
        assert!(scoped_existing_path(&state_b, root_a.join("same.txt")).is_err());

        registry.retire("window-a").expect("retire a");
        assert!(registry.existing_workspace("window-a").unwrap().is_none());
        assert_eq!(
            registry.workspace_for_label("window-a").err().unwrap(),
            "WINDOW_DESTROYED"
        );
        assert_eq!(
            fs::read(scoped_existing_path(&state_a, root_a.join("same.txt")).unwrap()).unwrap(),
            b"a",
            "an in-flight Arc remains valid without re-registering the label"
        );

        fs::remove_dir_all(root_a).expect("remove root a");
        fs::remove_dir_all(root_b).expect("remove root b");
    }

    #[test]
    fn two_window_snapshots_cannot_overwrite_the_same_file_silently() {
        let root = unique_temp_dir("same-file-two-windows");
        fs::create_dir_all(&root).expect("create workspace");
        let target = root.join("shared.md");
        fs::write(&target, b"original").expect("write shared file");
        let state_a = workspace_state(&root);
        let state_b = workspace_state(&root);
        let snapshot_a = read_text_file_impl(&state_a, &target).expect("read from window a");
        let snapshot_b = read_text_file_impl(&state_b, &target).expect("read from window b");

        let version_a =
            write_text_file_impl(&state_a, &target, "saved by window a", &snapshot_a.version)
                .expect("save window a");
        let error = write_text_file_impl(
            &state_b,
            &target,
            "stale save from window b",
            &snapshot_b.version,
        )
        .expect_err("stale window b must conflict");

        assert_eq!(error.code, "EXTERNAL_CHANGE");
        assert_eq!(fs::read_to_string(&target).unwrap(), "saved by window a");
        assert_eq!(version_a, version_for_bytes(b"saved by window a"));
        fs::remove_dir_all(root).expect("remove workspace");
    }

    #[test]
    fn asset_scope_prevents_cross_window_and_stale_resource_reads() {
        let root_a = unique_temp_dir("asset-a");
        let root_b = unique_temp_dir("asset-b");
        fs::create_dir_all(root_a.join("images")).expect("create a images");
        fs::create_dir_all(root_b.join("images")).expect("create b images");
        fs::write(root_a.join("images/same.txt"), b"asset-a").expect("write a asset");
        fs::write(root_b.join("images/same.txt"), b"asset-b").expect("write b asset");
        let state_a = WorkspaceState::default();
        let state_b = WorkspaceState::default();
        let binding_a = commit_workspace_candidate_for_label(
            &state_a,
            open_workspace_root(&root_a).unwrap(),
            None,
            1,
            "window-a",
        )
        .unwrap();
        let binding_b = commit_workspace_candidate_for_label(
            &state_b,
            open_workspace_root(&root_b).unwrap(),
            None,
            1,
            "window-b",
        )
        .unwrap();
        let preview = PreviewState::default();
        let uri_a = format!("/asset/{}/images/same.txt", binding_a.asset_scope);
        let uri_b = format!("/asset/{}/images/same.txt", binding_b.asset_scope);

        let response_a = local_asset_response(&state_a, &preview, "window-a", &uri_a);
        let response_b = local_asset_response(&state_b, &preview, "window-b", &uri_b);
        assert_eq!(response_a.status(), StatusCode::OK);
        assert_eq!(response_a.body(), b"asset-a");
        assert_eq!(response_b.body(), b"asset-b");
        assert_eq!(
            response_a.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(
            local_asset_response(&state_b, &preview, "window-b", &uri_a).status(),
            StatusCode::FORBIDDEN
        );

        let next = commit_workspace_candidate_for_label(
            &state_a,
            open_workspace_root(&root_a).unwrap(),
            None,
            2,
            "window-a",
        )
        .unwrap();
        assert_ne!(next.asset_scope, binding_a.asset_scope);
        assert_eq!(
            local_asset_response(&state_a, &preview, "window-a", &uri_a).status(),
            StatusCode::FORBIDDEN
        );

        fs::remove_dir_all(root_a).expect("remove root a");
        fs::remove_dir_all(root_b).expect("remove root b");
    }

    #[test]
    fn window_bootstrap_is_private_and_reload_becomes_self_restore() {
        let registry = WindowOpenRegistry::default();
        registry
            .register_main(Some("/workspace/a.md".to_string()))
            .expect("register main");
        let first = registry.consume_bootstrap("main").expect("main bootstrap");
        assert_eq!(first.initial_path.as_deref(), Some("/workspace/a.md"));
        assert_eq!(first.restore_mode, RestoreMode::None);
        let reload = registry
            .consume_bootstrap("main")
            .expect("reload bootstrap");
        assert_eq!(reload.initial_path, None);
        assert_eq!(reload.restore_mode, RestoreMode::SelfSession);
        assert_eq!(reload.session_id, first.session_id);

        let (label, dynamic) = registry
            .reserve_dynamic(None, RestoreMode::None)
            .expect("reserve dynamic");
        assert!(label.starts_with("workspace-"));
        assert_ne!(dynamic.session_id, first.session_id);
        assert_eq!(
            registry.consume_bootstrap(&label).unwrap().restore_mode,
            RestoreMode::None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn print_target_prefers_the_real_focused_window_then_the_registry_fallback() {
        let windows = vec![
            ("main".to_string(), false),
            ("workspace-2".to_string(), true),
        ];
        assert_eq!(
            select_print_target_label(&windows, Some("main")).as_deref(),
            Some("workspace-2")
        );

        let unfocused = vec![
            ("main".to_string(), false),
            ("workspace-2".to_string(), false),
        ];
        assert_eq!(
            select_print_target_label(&unfocused, Some("main")).as_deref(),
            Some("main")
        );
        assert_eq!(select_print_target_label(&unfocused, Some("stale")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn print_menu_item_is_inserted_immediately_before_close() {
        let labels = vec!["New Window".to_string(), "Close Window".to_string()];
        assert_eq!(print_menu_insert_position(&labels), Some(1));
        assert_eq!(
            print_menu_insert_position(&["New Window".to_string()]),
            None
        );
    }

    #[test]
    fn window_bootstrap_rolls_back_reservations_and_only_deduplicates_startup_once() {
        let registry = WindowOpenRegistry::default();
        registry
            .register_main(Some("/workspace/a.md".to_string()))
            .expect("register main");
        assert!(registry.consume_startup_duplicate("/workspace/a.md"));
        assert!(!registry.consume_startup_duplicate("/workspace/a.md"));
        assert!(!registry.consume_startup_duplicate("/workspace/b.md"));

        let (label, _) = registry
            .reserve_dynamic(Some("/workspace/b.md".to_string()), RestoreMode::None)
            .expect("reserve dynamic window");
        registry.rollback_reservation(&label);
        assert_eq!(
            registry.consume_bootstrap(&label).unwrap_err(),
            "WINDOW_BOOTSTRAP_NOT_FOUND"
        );
    }

    #[test]
    fn cold_macos_open_replaces_the_main_restore_before_bootstrap_consumption() {
        let registry = WindowOpenRegistry::default();
        registry.register_main(None).expect("register main");
        assert_eq!(
            registry
                .route_startup_open_to_main("/workspace/from-finder.md".to_string())
                .expect("assign cold open"),
            StartupOpenRoute::BootstrapAssigned
        );
        registry
            .wait_for_startup_routing()
            .expect("startup routing ready");
        let bootstrap = registry.consume_bootstrap("main").expect("main bootstrap");
        assert_eq!(
            bootstrap.initial_path.as_deref(),
            Some("/workspace/from-finder.md")
        );
        assert_eq!(bootstrap.restore_mode, RestoreMode::None);
        assert!(registry.consume_startup_duplicate("/workspace/from-finder.md"));
        assert_eq!(
            registry
                .route_startup_open_to_main("/workspace/later.md".to_string())
                .expect("later open is dynamic"),
            StartupOpenRoute::Dynamic
        );
    }

    #[test]
    fn late_cold_macos_open_reuses_the_live_main_window_once() {
        let registry = WindowOpenRegistry::default();
        registry.register_main(None).expect("register main");
        registry.finish_startup_bootstrap_gate();
        let bootstrap = registry.consume_bootstrap("main").expect("main bootstrap");
        assert_eq!(bootstrap.restore_mode, RestoreMode::LastActive);
        assert_eq!(
            registry
                .route_startup_open_to_main("/workspace/from-finder.md".to_string())
                .expect("route late cold open"),
            StartupOpenRoute::LiveMain
        );
        assert!(registry.consume_startup_duplicate("/workspace/from-finder.md"));
        assert_eq!(
            registry
                .route_startup_open_to_main("/workspace/later.md".to_string())
                .expect("later open is dynamic"),
            StartupOpenRoute::Dynamic
        );
    }

    #[test]
    fn pathless_launch_restores_last_active_after_startup_routing_finishes() {
        let registry = WindowOpenRegistry::default();
        registry.register_main(None).expect("register main");
        registry.finish_startup_bootstrap_gate();
        registry
            .finish_window_startup("main")
            .expect("finish main startup");
        registry
            .wait_for_startup_routing()
            .expect("startup routing ready");
        let bootstrap = registry.consume_bootstrap("main").expect("main bootstrap");
        assert_eq!(bootstrap.initial_path, None);
        assert_eq!(bootstrap.restore_mode, RestoreMode::LastActive);
    }

    #[test]
    fn quit_cancel_preserves_all_readiness_and_stale_replies_fail_closed() {
        let registry = QuitRegistry::default();
        let labels = ["a".to_string(), "b".to_string()].into_iter().collect();
        let (generation, _) = registry.begin(labels).unwrap().expect("begin quit");
        assert!(matches!(
            registry
                .respond("a", generation, AppQuitOutcome::DiscardApproved)
                .unwrap(),
            QuitAction::None
        ));
        let QuitAction::Abort { participants, .. } = registry
            .respond("b", generation, AppQuitOutcome::Cancel)
            .unwrap()
        else {
            panic!("cancel must abort the transaction");
        };
        assert_eq!(participants.len(), 2);
        assert!(!registry.is_active());
        assert_eq!(
            registry
                .respond("a", generation, AppQuitOutcome::Saved)
                .err()
                .unwrap(),
            "APP_QUIT_STALE_GENERATION"
        );
        assert!(!registry.consume_allow_exit());
    }

    #[test]
    fn quit_exits_only_after_every_live_window_is_ready() {
        let registry = QuitRegistry::default();
        let labels = ["a".to_string(), "b".to_string()].into_iter().collect();
        let (generation, _) = registry.begin(labels).unwrap().expect("begin quit");
        assert!(matches!(
            registry
                .respond("a", generation, AppQuitOutcome::Saved)
                .unwrap(),
            QuitAction::None
        ));
        assert!(matches!(registry.destroyed("b"), QuitAction::Exit));
        assert!(registry.consume_allow_exit());
        assert!(!registry.consume_allow_exit());
    }

    #[cfg(target_os = "macos")]
    struct TrashFixtureCleanup {
        prefix: String,
        root: PathBuf,
        original: PathBuf,
        trashed: Option<PathBuf>,
    }

    #[cfg(target_os = "macos")]
    impl TrashFixtureCleanup {
        fn valid(&self, path: &Path) -> bool {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&self.prefix))
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for TrashFixtureCleanup {
        fn drop(&mut self) {
            if let Some(trashed) = self.trashed.as_ref() {
                if self.valid(trashed) && self.valid(&self.original) && trashed.exists() {
                    let _ = fs::rename(trashed, &self.original);
                }
            }
            if self.valid(&self.original) && self.original.exists() {
                if self.original.is_dir() {
                    let _ = fs::remove_dir_all(&self.original);
                } else {
                    let _ = fs::remove_file(&self.original);
                }
            }
            if self.valid(&self.root) && self.root.exists() {
                let _ = fs::remove_dir(&self.root);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "moves one unique fixture through the real macOS Trash"]
    fn macos_moves_unique_fixture_to_trash_and_restores_it() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let prefix = format!("localview-trash-smoke-{}-{nonce}", std::process::id());
        let root = std::env::temp_dir().join(&prefix);
        let original = root.join(format!("{prefix}.md"));
        fs::create_dir_all(&root).expect("create unique trash fixture root");
        fs::write(&original, b"trash smoke").expect("create unique trash fixture");
        let mut cleanup = TrashFixtureCleanup {
            prefix: prefix.clone(),
            root: root.clone(),
            original: original.clone(),
            trashed: None,
        };
        let state = workspace_state(&root);
        let result = move_to_trash_impl(&state, &original).expect("move unique fixture to Trash");
        let trashed = PathBuf::from(&result.trashed_path);
        assert!(!original.exists());
        assert!(trashed.exists());
        assert!(
            cleanup.valid(&trashed),
            "unexpected resulting Trash path: {trashed:?}"
        );
        cleanup.trashed = Some(trashed.clone());
        fs::rename(&trashed, &original).expect("restore exact fixture from Trash");
        cleanup.trashed = None;
        assert!(original.exists());
        fs::remove_file(&original).expect("remove restored fixture");
        fs::remove_dir(&root).expect("remove fixture root");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "moves one unique non-empty directory through the real macOS Trash"]
    fn macos_moves_unique_directory_to_trash_and_restores_it() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let prefix = format!(
            "localview-trash-directory-smoke-{}-{nonce}",
            std::process::id()
        );
        let root = std::env::temp_dir().join(&prefix);
        let original = root.join(format!("{prefix}-folder"));
        fs::create_dir_all(&original).expect("create unique trash directory fixture");
        fs::write(original.join("proof.txt"), b"trash directory smoke")
            .expect("create child fixture");
        let mut cleanup = TrashFixtureCleanup {
            prefix: prefix.clone(),
            root: root.clone(),
            original: original.clone(),
            trashed: None,
        };
        let state = workspace_state(&root);
        let result = move_to_trash_impl(&state, &original).expect("move unique directory to Trash");
        let trashed = PathBuf::from(&result.trashed_path);
        assert!(!original.exists());
        assert!(trashed.is_dir());
        assert_eq!(
            fs::read(trashed.join("proof.txt")).expect("read child from Trash"),
            b"trash directory smoke"
        );
        assert!(
            cleanup.valid(&trashed),
            "unexpected resulting Trash path: {trashed:?}"
        );
        cleanup.trashed = Some(trashed.clone());
        fs::rename(&trashed, &original).expect("restore exact directory fixture from Trash");
        cleanup.trashed = None;
        assert!(original.is_dir());
        assert_eq!(
            fs::read(original.join("proof.txt")).expect("read restored child"),
            b"trash directory smoke"
        );
        fs::remove_dir_all(&original).expect("remove restored directory fixture");
        fs::remove_dir(&root).expect("remove directory fixture root");
    }
}
