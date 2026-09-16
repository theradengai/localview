//! Windows workspace operations. No index or document cache is created.
//! Directory handles deny write/delete sharing during each operation: ancestors cannot
//! become junctions or be replaced while a child is opened. Reparse points fail closed.
use super::*;
use std::{
    ffi::OsStr,
    fs::File,
    io::{Seek, SeekFrom},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            FileRenameInfo, GetFileInformationByHandle, GetLongPathNameW,
            SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        },
    },
};

const READ_ATTRIBUTES: u32 = 0x80;
const READ: u32 = 0x80000000;
const DELETE: u32 = 0x00010000;
const SHARE_READ: u32 = 1;
const SHARE_WRITE: u32 = 2;
const SHARE_DELETE: u32 = 4;
const NO_FOLLOW: u32 = 0x00200000;
const BACKUP: u32 = 0x02000000;
const REPARSE: u32 = 0x400;
static MUTATIONS: Mutex<()> = Mutex::new(());
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    volume: u32,
    index: u64,
}
impl Identity {
    pub(super) fn token(self) -> String {
        format!("{}:{}", self.volume, self.index)
    }
}
fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError::new(code, message)
}
fn native_error(value: windows::core::Error) -> CommandError {
    error("IO_ERROR", value.to_string())
}
fn handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
pub(super) fn identity(file: &File) -> Result<Identity, CommandError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(handle(file), &mut info).map_err(native_error)?;
    }
    Ok(Identity {
        volume: info.dwVolumeSerialNumber,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}
fn checked_file(path: &Path, access: u32, sharing: u32) -> Result<File, CommandError> {
    let file = fs::OpenOptions::new()
        .access_mode(access)
        .share_mode(sharing)
        .custom_flags(NO_FOLLOW | BACKUP)
        .open(path)
        .map_err(CommandError::io)?;
    if file.metadata().map_err(CommandError::io)?.file_attributes() & REPARSE != 0 {
        return Err(error(
            "REPARSE_POINT_UNSUPPORTED",
            "Symbolic links, junctions and other reparse points are not supported",
        ));
    }
    Ok(file)
}
pub(super) fn root_handle(path: &Path) -> Result<File, CommandError> {
    drive_path(path)?;
    let file = checked_file(
        path,
        READ_ATTRIBUTES,
        SHARE_READ | SHARE_WRITE | SHARE_DELETE,
    )?;
    if !file.metadata().map_err(CommandError::io)?.is_dir() {
        return Err(error("INVALID_PATH", "Workspace must be a directory"));
    }
    Ok(file)
}

/// Reject NT device paths, UNC/network roots, alternate streams and ambiguous names.
/// This first Windows release intentionally supports local drive-letter workspaces.
fn lexical_drive_path(path: &Path) -> Result<String, CommandError> {
    let raw = path
        .to_str()
        .ok_or_else(|| error("INVALID_PATH", "Path is not valid Unicode"))?
        .replace('/', "\\");
    let raw = raw.strip_prefix("\\\\?\\").unwrap_or(&raw);
    let bytes = raw.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err(error("INVALID_PATH", "Use a local drive-letter path; network and device paths are not supported in this Windows Beta"));
    }
    if raw[3..]
        .split('\\')
        .filter(|p| !p.is_empty())
        .any(|p| validate_name(p).is_err())
    {
        return Err(error(
            "INVALID_PATH",
            "Invalid or ambiguous Windows path component",
        ));
    }
    Ok(if raw.len() == 3 {
        raw.to_string()
    } else {
        raw.trim_end_matches('\\').to_string()
    })
}
// Expand DOS 8.3 names without canonicalizing away reparse-point boundaries.
// The deepest existing prefix also normalizes create/delete watcher paths.
fn drive_path(path: &Path) -> Result<String, CommandError> {
    let validated = lexical_drive_path(path)?;
    let mut prefix = PathBuf::from(&validated);
    let mut suffix = Vec::new();
    loop {
        let input = wide(prefix.as_os_str());
        let mut buffer = vec![0u16; 32768];
        let length =
            unsafe { GetLongPathNameW(PCWSTR(input.as_ptr()), Some(&mut buffer)) } as usize;
        if length > 0 && length < buffer.len() {
            let expanded = String::from_utf16(&buffer[..length])
                .map_err(|_| error("INVALID_PATH", "Path is not valid Unicode"))?;
            let mut expanded = PathBuf::from(expanded);
            for part in suffix.iter().rev() {
                expanded.push(part);
            }
            return lexical_drive_path(&expanded);
        }
        let Some(name) = prefix.file_name().map(|name| name.to_os_string()) else {
            return Ok(validated);
        };
        suffix.push(name);
        if !prefix.pop() {
            return Ok(validated);
        }
    }
}

pub(super) fn legacy_error(value: CommandError) -> String {
    if value.code == value.message || value.message == "Path is outside the active workspace" {
        value.message
    } else {
        format!("{}: {}", value.code, value.message)
    }
}

pub(super) fn validate_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.encode_utf16().count() > 255
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(error("INVALID_WINDOWS_NAME", "Windows names cannot contain reserved characters, trailing dots/spaces or alternate streams"));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err(error(
            "INVALID_WINDOWS_NAME",
            "This name is reserved by Windows",
        ));
    }
    Ok(())
}
struct Scope {
    root: PathBuf,
    generation: u64,
    pins: Vec<File>,
}
impl Scope {
    fn new(state: &WorkspaceState) -> Result<Self, CommandError> {
        let context = state
            .context
            .lock()
            .map_err(|_| error("IO_ERROR", "Workspace state unavailable"))?;
        let root = context
            .root
            .as_ref()
            .ok_or_else(|| error("WORKSPACE_CHANGED", "Open a workspace first"))?;
        drive_path(&root.path)?;
        let pinned = checked_file(&root.path, READ_ATTRIBUTES, SHARE_READ)?;
        if identity(&pinned)? != root.windows_identity {
            return Err(error("WORKSPACE_CHANGED", "Workspace root was replaced"));
        }
        Ok(Self {
            root: root.path.clone(),
            generation: context.generation,
            pins: vec![pinned],
        })
    }
    fn relative(&self, path: &Path) -> Result<Vec<String>, CommandError> {
        let root = drive_path(&self.root)?;
        let target = drive_path(path)?;
        let tail = if target.eq_ignore_ascii_case(&root) {
            ""
        } else {
            let prefix = format!("{}\\", root.trim_end_matches('\\'));
            if target.len() < prefix.len()
                || !target
                    .get(..prefix.len())
                    .is_some_and(|part| part.eq_ignore_ascii_case(&prefix))
            {
                return Err(error(
                    "WORKSPACE_CHANGED",
                    "Path is outside the active workspace",
                ));
            }
            &target[prefix.len()..]
        };
        Ok(tail
            .split('\\')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect())
    }
    fn directory(&mut self, requested: &Path) -> Result<PathBuf, CommandError> {
        let mut path = self.root.clone();
        for component in self.relative(requested)? {
            if is_document_bundle(&path, true) {
                return Err(error(
                    "MOVE_BUNDLE_BOUNDARY",
                    "Document bundle interiors are not workspace folders",
                ));
            }
            path.push(component);
            let pin = checked_file(&path, READ_ATTRIBUTES, SHARE_READ)?;
            if !pin.metadata().map_err(CommandError::io)?.is_dir() {
                return Err(error("INVALID_PATH", "Expected a directory"));
            }
            self.pins.push(pin);
        }
        if is_document_bundle(&path, true) {
            return Err(error(
                "MOVE_BUNDLE_BOUNDARY",
                "Document bundle interiors are not workspace folders",
            ));
        }
        Ok(path)
    }
    fn target(
        &mut self,
        requested: &Path,
        access: u32,
        sharing: u32,
    ) -> Result<(PathBuf, File), CommandError> {
        let components = self.relative(requested)?;
        if components.is_empty() {
            return Err(error(
                "RENAME_ROOT_FORBIDDEN",
                "The workspace root cannot be changed",
            ));
        }
        let parent = components[..components.len() - 1]
            .iter()
            .fold(self.root.clone(), |p, c| p.join(c));
        let parent = self.directory(&parent)?;
        let path = parent.join(components.last().unwrap());
        let file = checked_file(&path, access, sharing)?;
        Ok((path, file))
    }
    fn current(&self, state: &WorkspaceState) -> Result<(), CommandError> {
        let (root, generation) = active_workspace_snapshot(state).map_err(CommandError::legacy)?;
        if generation != self.generation || root != self.root {
            return Err(error(
                "WORKSPACE_CHANGED",
                "Workspace changed during the operation",
            ));
        }
        Ok(())
    }
}
pub(super) fn scoped_path(
    state: &WorkspaceState,
    requested: &Path,
) -> Result<PathBuf, CommandError> {
    let mut scope = Scope::new(state)?;
    if scope.relative(requested)?.is_empty() {
        return Ok(scope.root.clone());
    }
    let (path, _file) = scope.target(
        requested,
        READ_ATTRIBUTES,
        SHARE_READ | SHARE_WRITE | SHARE_DELETE,
    )?;
    fs::canonicalize(path).map_err(CommandError::io)
}
pub(super) fn read_bytes(
    state: &WorkspaceState,
    requested: &Path,
) -> Result<Vec<u8>, CommandError> {
    let mut scope = Scope::new(state)?;
    let (_, mut file) = scope.target(requested, READ, SHARE_READ)?;
    if !file.metadata().map_err(CommandError::io)?.is_file() {
        return Err(error("INVALID_PATH", "Expected a regular file"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(CommandError::io)?;
    scope.current(state)?;
    Ok(bytes)
}
pub(super) fn create_markdown<F: FnOnce(), G: FnOnce()>(
    state: &WorkspaceState,
    parent: &Path,
    name: &str,
    after_parent: F,
    before_create: G,
) -> Result<CreatedTextFile, String> {
    let result = (|| {
        let _serial = MUTATIONS
            .lock()
            .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
        validate_name(name)?;
        let mut scope = Scope::new(state)?;
        let parent = scope.directory(parent).map_err(|value| {
            if matches!(value.code.as_str(), "INVALID_PATH" | "MOVE_BUNDLE_BOUNDARY") {
                error(
                    "MARKDOWN_PARENT_NOT_DIRECTORY",
                    "MARKDOWN_PARENT_NOT_DIRECTORY",
                )
            } else {
                value
            }
        })?;
        after_parent();
        before_create();
        scope.current(state)?;
        let path = parent.join(name);
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .custom_flags(NO_FOLLOW)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    error("MARKDOWN_FILE_EXISTS", "MARKDOWN_FILE_EXISTS")
                } else {
                    CommandError::io(e)
                }
            })?;
        drop(file);
        Ok(CreatedTextFile {
            entry: FsEntry {
                name: name.into(),
                path: path.to_string_lossy().into_owned(),
                kind: "md".into(),
            },
            snapshot: TextFileSnapshot {
                content: String::new(),
                version: version_for_bytes(b""),
            },
        })
    })();
    result.map_err(legacy_error)
}
pub(super) fn create_folder<F: FnOnce(), G: Fn(DirectoryCreateHookPhase)>(
    state: &WorkspaceState,
    parent: &Path,
    name: &str,
    after_parent: F,
    hook: G,
) -> Result<FsEntry, String> {
    let result = (|| {
        let _serial = MUTATIONS
            .lock()
            .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
        validate_name(name)?;
        let mut scope = Scope::new(state)?;
        let parent = scope.directory(parent).map_err(|value| {
            if matches!(value.code.as_str(), "INVALID_PATH" | "MOVE_BUNDLE_BOUNDARY") {
                error(
                    "DIRECTORY_PARENT_NOT_DIRECTORY",
                    "DIRECTORY_PARENT_NOT_DIRECTORY",
                )
            } else {
                value
            }
        })?;
        after_parent();
        hook(DirectoryCreateHookPhase::BeforeFinalCreate);
        scope.current(state)?;
        let path = parent.join(name);
        fs::create_dir(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                error("DIRECTORY_ENTRY_EXISTS", "DIRECTORY_ENTRY_EXISTS")
            } else {
                CommandError::io(e)
            }
        })?;
        let created = scope.directory(&path)?;
        hook(DirectoryCreateHookPhase::AfterCreate);
        entry_from_path(&created).map_err(CommandError::legacy)
    })();
    result.map_err(legacy_error)
}
fn unique() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
/// The handle is the source object, not a name that can be replaced after preflight.
/// Destination ancestors stay pinned. ReplaceIfExists=false never overwrites/copy-deletes.
fn rename_handle(file: &File, destination: &Path) -> Result<(), CommandError> {
    #[repr(C)]
    struct RenameInfo {
        replace: u32,
        root: HANDLE,
        length: u32,
        name: [u16; 1],
    }
    let name = wide(destination.as_os_str());
    let offset = std::mem::offset_of!(RenameInfo, name);
    let size = (offset + name.len() * 2).max(std::mem::size_of::<RenameInfo>());
    let mut aligned = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    unsafe {
        let info = aligned.as_mut_ptr().cast::<RenameInfo>();
        (*info).replace = 0;
        (*info).root = HANDLE::default();
        (*info).length = ((name.len() - 1) * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            aligned.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(handle(file), FileRenameInfo, info.cast(), size as u32)
            .map_err(native_error)
    }
}
pub(super) fn write_text(
    state: &WorkspaceState,
    requested: &Path,
    content: &str,
    expected: &str,
) -> Result<String, CommandError> {
    write_text_with_hook(state, requested, content, expected, || {})
}
fn write_text_with_hook<F: FnOnce()>(
    state: &WorkspaceState,
    requested: &Path,
    content: &str,
    expected: &str,
    before_commit: F,
) -> Result<String, CommandError> {
    use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};
    let _serial = MUTATIONS
        .lock()
        .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
    let mut scope = Scope::new(state)?;
    let (path, mut original) = scope.target(requested, READ, SHARE_READ | SHARE_DELETE)?;
    let metadata = original.metadata().map_err(CommandError::io)?;
    if !metadata.is_file() || metadata.permissions().readonly() {
        return Err(error(
            "PERMISSION_DENIED",
            "File is not an editable regular file",
        ));
    }
    let before_id = identity(&original)?;
    let mut bytes = Vec::new();
    original.read_to_end(&mut bytes).map_err(CommandError::io)?;
    if version_for_bytes(&bytes) != expected {
        return Err(error("EXTERNAL_CHANGE", "The file changed on disk"));
    }
    let temp = path
        .parent()
        .unwrap()
        .join(format!(".localview-{}.tmp", unique()));
    let mut temporary = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .custom_flags(NO_FOLLOW)
        .open(&temp)
        .map_err(CommandError::io)?;
    let temp_id = identity(&temporary)?;
    let prepared = temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.sync_all());
    drop(temporary);
    if let Err(e) = prepared {
        let _ = fs::remove_file(&temp);
        return Err(CommandError::io(e));
    }
    before_commit();
    let result = (|| {
        scope.current(state)?;
        let latest = checked_file(&path, READ_ATTRIBUTES, SHARE_READ | SHARE_DELETE)?;
        if identity(&latest)? != before_id {
            return Err(error("EXTERNAL_CHANGE", "The file was replaced on disk"));
        }
        drop(latest);
        original
            .seek(SeekFrom::Start(0))
            .map_err(CommandError::io)?;
        bytes.clear();
        original.read_to_end(&mut bytes).map_err(CommandError::io)?;
        if version_for_bytes(&bytes) != expected {
            return Err(error("EXTERNAL_CHANGE", "The file changed on disk"));
        }
        let latest_temp = checked_file(
            &temp,
            READ_ATTRIBUTES,
            SHARE_READ | SHARE_WRITE | SHARE_DELETE,
        )?;
        if identity(&latest_temp)? != temp_id {
            return Err(error(
                "WORKSPACE_CHANGED",
                "Temporary save file was replaced",
            ));
        }
        drop(latest_temp);
        let destination = wide(path.as_os_str());
        let replacement = wide(temp.as_os_str());
        unsafe {
            ReplaceFileW(
                PCWSTR(destination.as_ptr()),
                PCWSTR(replacement.as_ptr()),
                PCWSTR::null(),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
            .map_err(native_error)?;
        }
        Ok(version_for_bytes(content.as_bytes()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn parent_id(path: &Path) -> Result<String, CommandError> {
    identity(&checked_file(path, READ_ATTRIBUTES, SHARE_READ)?).map(Identity::token)
}
fn preflight_move(
    state: &WorkspaceState,
    source: &Path,
    destination: &Path,
) -> Result<(Scope, File, MoveCandidate), CommandError> {
    let mut scope = Scope::new(state)?;
    let (source, file) = scope.target(source, READ_ATTRIBUTES | DELETE, SHARE_READ)?;
    let metadata = file.metadata().map_err(CommandError::io)?;
    let source_id = identity(&file)?;
    let destination = scope.directory(destination)?;
    let parent = source.parent().unwrap();
    if drive_path(parent)?.eq_ignore_ascii_case(&drive_path(&destination)?) {
        return Err(error("MOVE_SAME_PARENT", "Item is already in this folder"));
    }
    let source_text = drive_path(&source)?;
    let dest_text = drive_path(&destination)?;
    if metadata.is_dir()
        && (dest_text.eq_ignore_ascii_case(&source_text)
            || dest_text
                .to_lowercase()
                .starts_with(&format!("{}\\", source_text.to_lowercase())))
    {
        return Err(error(
            "MOVE_DESTINATION_INSIDE_SOURCE",
            "A folder cannot move inside itself",
        ));
    }
    let destination_id = identity(&checked_file(&destination, READ_ATTRIBUTES, SHARE_READ)?)?;
    if source_id.volume != destination_id.volume {
        return Err(error(
            "MOVE_CROSS_DEVICE_UNSUPPORTED",
            "Cross-volume moves are not supported",
        ));
    }
    let target = destination.join(source.file_name().unwrap());
    if fs::symlink_metadata(&target).is_ok() {
        return Err(error(
            "MOVE_DESTINATION_EXISTS",
            "An item with this name already exists",
        ));
    }
    let candidate = MoveCandidate {
        source_path: source.to_string_lossy().into_owned(),
        destination_directory: destination.to_string_lossy().into_owned(),
        destination_path: target.to_string_lossy().into_owned(),
        workspace_generation: scope.generation,
        source_parent_identity: parent_id(parent)?,
        source_identity: source_id.token(),
        destination_identity: destination_id.token(),
        source_is_directory: metadata.is_dir(),
        source_is_bundle: is_document_bundle(&source, metadata.is_dir()),
    };
    Ok((scope, file, candidate))
}
pub(super) fn prepare_move(
    state: &WorkspaceState,
    source: &Path,
    destination: &Path,
) -> Result<MoveCandidate, CommandError> {
    preflight_move(state, source, destination).map(|(_, _, c)| c)
}
pub(super) fn move_entry(
    state: &WorkspaceState,
    candidate: &MoveCandidate,
) -> Result<MovedWorkspaceEntry, CommandError> {
    let _serial = MUTATIONS
        .lock()
        .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
    let (scope, file, current) = preflight_move(
        state,
        Path::new(&candidate.source_path),
        Path::new(&candidate.destination_directory),
    )?;
    if &current != candidate {
        return Err(error(
            "MOVE_SOURCE_CHANGED",
            "The move target or workspace changed",
        ));
    }
    scope.current(state)?;
    rename_handle(&file, Path::new(&candidate.destination_path))?;
    let entry = entry_from_path(Path::new(&candidate.destination_path))
        .map_err(|e| error("MOVE_OUTCOME_UNCERTAIN", e))?;
    Ok(MovedWorkspaceEntry {
        original_path: candidate.source_path.clone(),
        moved_path: candidate.destination_path.clone(),
        entry,
    })
}
fn preflight_rename(
    state: &WorkspaceState,
    requested: &Path,
    new_name: &str,
) -> Result<(Scope, File, RenameCandidate), CommandError> {
    let mut scope = Scope::new(state)?;
    let (source, file) = scope.target(requested, READ_ATTRIBUTES | DELETE, SHARE_READ)?;
    let metadata = file.metadata().map_err(CommandError::io)?;
    let bundle = is_document_bundle(&source, metadata.is_dir());
    let name = validate_workspace_rename_name(
        source.file_name().and_then(|s| s.to_str()).unwrap_or(""),
        new_name,
        metadata.is_dir(),
        bundle,
    )?;
    validate_name(&name).map_err(|e| error("RENAME_INVALID_NAME", e.message))?;
    let parent = source.parent().unwrap();
    let target = parent.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(error(
            "RENAME_DESTINATION_EXISTS",
            "An item with this name already exists",
        ));
    }
    let candidate = RenameCandidate {
        source_path: source.to_string_lossy().into_owned(),
        destination_path: target.to_string_lossy().into_owned(),
        workspace_generation: scope.generation,
        parent_identity: parent_id(parent)?,
        source_identity: identity(&file)?.token(),
        source_is_directory: metadata.is_dir(),
        source_is_bundle: bundle,
    };
    Ok((scope, file, candidate))
}
pub(super) fn prepare_rename(
    state: &WorkspaceState,
    source: &Path,
    name: &str,
) -> Result<RenameCandidate, CommandError> {
    preflight_rename(state, source, name).map(|(_, _, c)| c)
}
pub(super) fn rename_entry(
    state: &WorkspaceState,
    candidate: &RenameCandidate,
) -> Result<RenamedWorkspaceEntry, CommandError> {
    let _serial = MUTATIONS
        .lock()
        .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
    let name = Path::new(&candidate.destination_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| error("RENAME_INVALID_NAME", "Invalid destination"))?;
    let (scope, file, current) = preflight_rename(state, Path::new(&candidate.source_path), name)?;
    if &current != candidate {
        return Err(error(
            "RENAME_SOURCE_CHANGED",
            "The rename target or workspace changed",
        ));
    }
    scope.current(state)?;
    rename_handle(&file, Path::new(&candidate.destination_path))?;
    let entry = entry_from_path(Path::new(&candidate.destination_path))
        .map_err(|e| error("RENAME_OUTCOME_UNCERTAIN", e))?;
    Ok(RenamedWorkspaceEntry {
        original_path: candidate.source_path.clone(),
        renamed_path: candidate.destination_path.clone(),
        entry,
    })
}
fn reconcile(
    state: &WorkspaceState,
    generation: u64,
    source: &str,
    destination: &str,
    expected: &str,
) -> Result<(u8, Option<FsEntry>), CommandError> {
    let mut scope = Scope::new(state)?;
    if scope.generation != generation {
        return Err(error("WORKSPACE_CHANGED", "Workspace changed"));
    }
    let mut found = Vec::new();
    for (which, path) in [(1, source), (2, destination)] {
        scope.relative(Path::new(path))?;
        if let Ok((path, file)) = scope.target(Path::new(path), READ_ATTRIBUTES, SHARE_READ) {
            if identity(&file)?.token() == expected {
                found.push((which, entry_from_path(&path).ok()));
            }
        }
    }
    Ok(if found.len() == 1 {
        found.remove(0)
    } else {
        (0, None)
    })
}
pub(super) fn reconcile_move(
    state: &WorkspaceState,
    c: &MoveCandidate,
) -> Result<MoveReconciliation, CommandError> {
    let (which, entry) = reconcile(
        state,
        c.workspace_generation,
        &c.source_path,
        &c.destination_path,
        &c.source_identity,
    )?;
    Ok(MoveReconciliation {
        outcome: match which {
            1 => MoveReconciliationOutcome::Source,
            2 => MoveReconciliationOutcome::Destination,
            _ => MoveReconciliationOutcome::Ambiguous,
        },
        entry,
    })
}
pub(super) fn reconcile_rename(
    state: &WorkspaceState,
    c: &RenameCandidate,
) -> Result<RenameReconciliation, CommandError> {
    let (which, entry) = reconcile(
        state,
        c.workspace_generation,
        &c.source_path,
        &c.destination_path,
        &c.source_identity,
    )?;
    Ok(RenameReconciliation {
        outcome: match which {
            1 => RenameReconciliationOutcome::Source,
            2 => RenameReconciliationOutcome::Destination,
            _ => RenameReconciliationOutcome::Ambiguous,
        },
        entry,
    })
}
pub(super) fn save_images<F: FnOnce()>(
    state: &WorkspaceState,
    document: &Path,
    generation: u64,
    payloads: &[(&str, &[u8])],
    before_write: F,
) -> Result<Vec<String>, CommandError> {
    let _serial = MUTATIONS
        .lock()
        .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
    let mut scope = Scope::new(state)?;
    if scope.generation != generation || file_kind(document, false) != "md" {
        return Err(error(
            "IMAGE_PASTE_CONTEXT_CHANGED",
            "Markdown workspace changed",
        ));
    }
    let (document, _file) = scope.target(document, READ_ATTRIBUTES, SHARE_READ)?;
    let assets = document.parent().unwrap().join("assets");
    match fs::create_dir(&assets) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(CommandError::io(e)),
    }
    scope.directory(&assets)?;
    before_write();
    scope.current(state)?;
    let mut sources = Vec::new();
    for (extension, bytes) in payloads {
        let nonce = unique();
        let name = format!("image-{nonce}.{extension}");
        let temp = assets.join(format!(".localview-{nonce}.tmp"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(0x40000000 | DELETE)
            .share_mode(SHARE_READ)
            .custom_flags(NO_FOLLOW)
            .open(&temp)
            .map_err(CommandError::io)?;
        let result = (|| {
            file.write_all(bytes).map_err(CommandError::io)?;
            file.sync_all().map_err(CommandError::io)?;
            rename_handle(&file, &assets.join(&name))
        })();
        drop(file);
        if let Err(e) = result {
            let _ = fs::remove_file(temp);
            return Err(e);
        }
        sources.push(format!("assets/{name}"));
    }
    Ok(sources)
}
pub(super) fn prepare_trash(
    state: &WorkspaceState,
    requested: &Path,
) -> Result<TrashCandidate, CommandError> {
    let mut scope = Scope::new(state)?;
    if scope.relative(requested)?.is_empty() {
        return Err(error(
            "TRASH_ROOT_FORBIDDEN",
            "Workspace root cannot be recycled",
        ));
    }
    let (path, file) = scope.target(requested, READ_ATTRIBUTES, SHARE_READ)?;
    Ok(TrashCandidate {
        original_path: path.to_string_lossy().into_owned(),
        workspace_generation: scope.generation,
        parent_identity: parent_id(path.parent().unwrap())?,
        target_identity: identity(&file)?.token(),
        is_dir: file.metadata().map_err(CommandError::io)?.is_dir(),
    })
}
pub(super) fn trash(
    state: &WorkspaceState,
    candidate: &TrashCandidate,
) -> Result<TrashedItem, CommandError> {
    let _serial = MUTATIONS
        .lock()
        .map_err(|_| error("IO_ERROR", "File operations unavailable"))?;
    let current = prepare_trash(state, Path::new(&candidate.original_path))?;
    if &current != candidate {
        return Err(error("TRASH_TARGET_CHANGED", "Trash target changed"));
    }
    let mut scope = Scope::new(state)?;
    scope.directory(Path::new(&candidate.original_path).parent().unwrap())?;
    scope.current(state)?;
    let path = candidate.original_path.clone();
    let expected = candidate.target_identity.clone();
    let recycled =
        std::thread::spawn(move || super::windows_recycle::recycle(Path::new(&path), &expected))
            .join()
            .map_err(|_| error("TRASH_FAILED", "Recycle operation failed"))??;
    Ok(TrashedItem {
        original_path: candidate.original_path.clone(),
        trashed_path: recycled,
    })
}

/// Normalize watcher events without requiring the affected file to still exist.
pub(super) fn event_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let root_text = drive_path(root).ok()?;
    let target = drive_path(path).ok()?;
    if target.eq_ignore_ascii_case(&root_text) {
        return Some(root.to_path_buf());
    }
    let prefix = format!("{}\\", root_text.trim_end_matches('\\'));
    if !target.get(..prefix.len())?.eq_ignore_ascii_case(&prefix) {
        return None;
    }
    Some(root.join(&target[prefix.len()..]))
}

#[cfg(test)]
#[path = "windows_fs_tests.rs"]
mod tests;
