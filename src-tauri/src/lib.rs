use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    http::{header, Response, StatusCode},
    Emitter, Manager,
};

mod quick_look;
mod spreadsheet;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextFileSnapshot {
    content: String,
    version: String,
}

#[derive(Default)]
struct OpenState {
    frontend_ready: AtomicBool,
    pending: Mutex<Option<String>>,
}

#[derive(Default)]
struct WorkspaceState {
    root: Mutex<Option<PathBuf>>,
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
        .root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Open a workspace before accessing files".to_string())
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
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let root = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("The selected workspace is not a directory".to_string());
    }
    *state
        .root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_string())? = Some(root.clone());
    Ok(root.to_string_lossy().into_owned())
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
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}:{}", bytes.len())
}

#[tauri::command]
fn read_text_file(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<TextFileSnapshot, String> {
    let path = scoped_existing_path(&state, path)?;
    if !path.is_file() {
        return Err("The requested path is not a file".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let version = version_for_bytes(&bytes);
    let content =
        String::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8".to_string())?;
    Ok(TextFileSnapshot { content, version })
}

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

#[tauri::command]
fn write_text_file(
    path: String,
    content: String,
    expected_version: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let path = scoped_existing_path(&state, path)?;
    if !path.is_file() {
        return Err("The requested path is not a file".to_string());
    }

    let current = fs::read(&path).map_err(|error| error.to_string())?;
    if version_for_bytes(&current) != expected_version {
        return Err("EXTERNAL_CHANGE: the file changed on disk".to_string());
    }

    let bytes = content.as_bytes();
    let temp_path = create_temp_file(&path, bytes)?;

    let latest = fs::read(&path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })?;
    if version_for_bytes(&latest) != expected_version {
        let _ = fs::remove_file(&temp_path);
        return Err("EXTERNAL_CHANGE: the file changed on disk".to_string());
    }

    if let Err(error) = fs::rename(&temp_path, &path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }

    Ok(version_for_bytes(bytes))
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
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .expect("valid local asset response")
}

fn local_asset_response(state: &WorkspaceState, uri_path: &str) -> Response<Vec<u8>> {
    let result = (|| -> Result<(PathBuf, Vec<u8>), StatusCode> {
        let decoded = percent_decode_str(uri_path.trim_start_matches('/'))
            .decode_utf8()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let relative = Path::new(decoded.as_ref());
        if relative.is_absolute() {
            return Err(StatusCode::FORBIDDEN);
        }
        let root = active_workspace_root(state).map_err(|_| StatusCode::FORBIDDEN)?;
        let requested = root.join(relative);
        let canonical = fs::canonicalize(requested).map_err(|_| StatusCode::NOT_FOUND)?;
        if canonical == root || !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(StatusCode::FORBIDDEN);
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
        .register_uri_scheme_protocol("localview", |context, request| {
            let state = context.app_handle().state::<WorkspaceState>();
            local_asset_response(&state, request.uri().path())
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
            write_text_file,
            find_workspace_root,
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
}
