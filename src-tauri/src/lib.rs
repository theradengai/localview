use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    kind: String,
}

fn file_kind(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "folder".into();
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "md",
        "html" | "htm" => "html",
        "txt" | "json" | "jsonc" | "yaml" | "yml" | "toml" | "xml" | "css" | "js"
        | "jsx" | "ts" | "tsx" | "rs" | "py" | "sh" | "csv" | "log" => "text",
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

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FsEntry>, String> {
    let mut entries = Vec::new();
    let directory = fs::read_dir(&path).map_err(|error| error.to_string())?;

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
    entry_from_path(Path::new(&path))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn find_workspace_root(file_path: String) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    let start = if source.is_dir() {
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

fn startup_path_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|value| !value.starts_with('-') && Path::new(value).exists())
}

#[tauri::command]
fn get_startup_path() -> Option<String> {
    startup_path_from_args(std::env::args())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            if let Some(path) = startup_path_from_args(args) {
                let _ = app.emit("open-path", path);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_directory,
            inspect_path,
            read_text_file,
            write_text_file,
            find_workspace_root,
            get_startup_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running LocalView");
}
