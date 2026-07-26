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
    fs::{self as unix_fs, FileType, Mode, OFlags},
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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    http::{header, Response, StatusCode},
    Emitter, Manager,
};

#[cfg(target_os = "macos")]
use objc2::rc::autoreleasepool;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString, NSURL};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

mod quick_look;
mod spreadsheet;

#[derive(Clone, Debug, Serialize)]
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

#[derive(Default)]
struct OpenState {
    frontend_ready: AtomicBool,
    pending: Mutex<Option<String>>,
}

const WATCH_BACKEND_DEBOUNCE_MS: u64 = 120;
type WorkspaceDebouncer = Debouncer<RecommendedWatcher, NoCache>;

#[derive(Default)]
struct WorkspaceState {
    context: Mutex<WorkspaceContext>,
    next_generation: AtomicU64,
}

#[derive(Default)]
struct PreviewState {
    capabilities: Mutex<HashMap<String, PreviewCapability>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
struct PreviewCapability {
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

fn extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_document_bundle(path: &Path, is_dir: bool) -> bool {
    is_dir
        && matches!(
            extension_lowercase(path).as_str(),
            "numbers" | "pages" | "key"
        )
}

fn file_kind(path: &Path, is_dir: bool) -> String {
    if is_document_bundle(path, is_dir) {
        return match extension_lowercase(path).as_str() {
            "numbers" => "spreadsheet",
            "pages" => "document",
            "key" => "presentation",
            _ => unreachable!("document bundle extensions are checked above"),
        }
        .into();
    }

    if is_dir {
        return "folder".into();
    }

    let extension = extension_lowercase(path);

    match extension.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "md",
        "html" | "htm" => "html",
        "txt" | "json" | "jsonc" | "yaml" | "yml" | "toml" | "xml" | "css" | "js" | "jsx"
        | "ts" | "tsx" | "rs" | "py" | "sh" | "csv" | "log" => "text",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" | "ico" => "image",
        "pdf" => "pdf",
        "xls" | "xlsx" | "ods" | "numbers" => "spreadsheet",
        "ppt" | "pptx" | "odp" | "key" => "presentation",
        "doc" | "docx" | "odt" | "rtf" | "pages" => "document",
        _ => "other",
    }
    .into()
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
    commit_workspace_candidate(state, root, watcher, generation)
}

fn commit_workspace_candidate(
    state: &WorkspaceState,
    root: WorkspaceRoot,
    watcher: Option<WorkspaceDebouncer>,
    generation: u64,
) -> Result<WorkspaceBinding, String> {
    let root_path = root.path.clone();
    let watching = watcher.is_some();
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
        watcher,
    };
    Ok(WorkspaceBinding {
        path: root_path.to_string_lossy().into_owned(),
        generation,
        watching,
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
                    let _ = app.emit(
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
                let _ = app.emit(
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<WorkspaceBinding, String> {
    let root = open_workspace_root(Path::new(&path))?;
    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let watcher = create_workspace_watcher(app.clone(), root.path.clone(), generation).ok();
    let binding = commit_workspace_candidate(&state, root, watcher, generation)?;
    Ok(binding)
}

#[tauri::command]
fn list_directory(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<FsEntry>, String> {
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
        return Err("MARKDOWN_PARENT_NOT_DIRECTORY".to_string());
    }
    let relative = parent
        .strip_prefix(&root.path)
        .map_err(|_| "Path is outside the active workspace".to_string())?;

    after_parent_canonicalized();

    let mut directory = root.directory;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("MARKDOWN_PARENT_CHANGED".to_string());
        };
        directory = unix_fs::openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            if matches!(error, Errno::NOENT | Errno::NOTDIR | Errno::LOOP) {
                "MARKDOWN_PARENT_CHANGED".to_string()
            } else {
                format!("CREATE_MARKDOWN_FAILED: {error}")
            }
        })?;
    }
    validate_directory_identity(&parent, &directory, "MARKDOWN_PARENT_CHANGED")?;
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
        let (parent, directory) =
            open_scoped_parent_directory_with_hook(state, parent_path, after_parent_canonicalized)?;
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<CreatedTextFile, String> {
    create_markdown_file_impl(&state, Path::new(&parent_path), &name)
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<TextFileSnapshot, CommandError> {
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, CommandError> {
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<TrashCandidate, CommandError> {
    #[cfg(not(unix))]
    {
        let _ = (path, state);
        Err(CommandError::new("IO_ERROR", "TRASH_UNSUPPORTED"))
    }
    #[cfg(unix)]
    {
        let preflight = trash_preflight(&state, Path::new(&path)).map_err(CommandError::legacy)?;
        Ok(trash_candidate(&preflight))
    }
}

#[tauri::command]
fn move_to_trash(
    candidate: TrashCandidate,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<TrashedItem, CommandError> {
    move_candidate_to_trash_impl(&state, &candidate).map_err(CommandError::legacy)
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
    workspace_state: tauri::State<'_, WorkspaceState>,
    preview_state: tauri::State<'_, PreviewState>,
) -> Result<HtmlPreviewCapability, CommandError> {
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
        "{}:{workspace_generation}:{nonce}:{timestamp}:{}",
        std::process::id(),
        document.to_string_lossy()
    );
    let token = Sha256::digest(token_source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let capability = PreviewCapability {
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
    preview_state: tauri::State<'_, PreviewState>,
) -> Result<(), CommandError> {
    preview_state
        .capabilities
        .lock()
        .map_err(|_| CommandError::new("IO_ERROR", "Preview state is unavailable"))?
        .remove(&token);
    Ok(())
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

    path.exists().then_some(path)
}

fn startup_path_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find_map(argument_to_path)
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_startup_path(state: tauri::State<'_, OpenState>) -> Option<String> {
    state.frontend_ready.store(true, Ordering::SeqCst);
    startup_path_from_args(std::env::args()).or_else(|| state.pending.lock().ok()?.take())
}

fn forward_open_path(app: &tauri::AppHandle, path: PathBuf) {
    let path_string = path.to_string_lossy().into_owned();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    let state = app.state::<OpenState>();
    if state.frontend_ready.load(Ordering::SeqCst) {
        let _ = app.emit("open-path", path_string);
    } else if let Ok(mut pending) = state.pending.lock() {
        *pending = Some(path_string);
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
            } else {
                let (root, generation) =
                    active_workspace_snapshot(state).map_err(|_| StatusCode::FORBIDDEN)?;
                (root, generation, None, raw_path)
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
    let mut builder = tauri::Builder::default()
        .manage(OpenState::default())
        .manage(WorkspaceState::default())
        .manage(PreviewState::default())
        .register_uri_scheme_protocol("localview", |context, request| {
            let state = context.app_handle().state::<WorkspaceState>();
            let preview_state = context.app_handle().state::<PreviewState>();
            local_asset_response(&state, &preview_state, request.uri().path())
        });

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = args.into_iter().skip(1).find_map(argument_to_path) {
                forward_open_path(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
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
            write_text_file,
            prepare_trash,
            move_to_trash,
            find_workspace_root,
            prepare_html_preview,
            release_html_preview,
            get_startup_path,
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

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            if let Some(path) = urls.into_iter().find_map(|url| url.to_file_path().ok()) {
                forward_open_path(app, path);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::sync::{Arc, Barrier};

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
                watcher: None,
            }),
            next_generation: AtomicU64::new(1),
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
                    root: fs::canonicalize(&root).expect("canonical root"),
                    document: fs::canonicalize(&document).expect("canonical document"),
                    workspace_generation: 1,
                },
            );

        let response =
            local_asset_response(&state, &preview_state, "/preview/test-token/index.html");
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

        let denied =
            local_asset_response(&state, &preview_state, "/preview/wrong-token/index.html");
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        fs::remove_dir_all(root).expect("remove workspace");
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
                let _ = fs::remove_file(&self.original);
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
}
