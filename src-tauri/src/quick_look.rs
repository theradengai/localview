use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use super::{is_document_bundle, scoped_existing_path, WorkspaceState};

#[cfg(test)]
const QUICK_LOOK_EXTENSIONS: &[&str] = &[
    "xls", "xlsx", "ods", "numbers", "doc", "docx", "odt", "rtf", "pages", "ppt", "pptx", "odp",
    "key",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemPreviewSnapshot {
    mime_type: &'static str,
    data_base64: String,
    width: usize,
    height: usize,
}

#[cfg(test)]
fn is_quick_look_extension(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    QUICK_LOOK_EXTENSIONS.contains(&extension.as_str())
}

fn validate_preview_target(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_file() || is_document_bundle(path, metadata.is_dir()) {
        return Ok(());
    }
    Err("QUICK_LOOK_UNSUPPORTED_TARGET".to_string())
}

fn scoped_preview_target(state: &WorkspaceState, path: String) -> Result<PathBuf, String> {
    let path = scoped_existing_path(state, path)?;
    validate_preview_target(&path)?;
    Ok(path)
}

#[tauri::command]
pub(crate) fn open_in_default_app(
    path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path = scoped_preview_target(&state, path)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| format!("OPEN_DEFAULT_APP_FAILED: {error}"))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use block2::RcBlock;
    use objc2::{
        rc::autoreleasepool,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
        AnyThread, MainThreadMarker,
    };
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBackingStoreType, NSBitmapImageFileType, NSBitmapImageRep,
        NSBitmapImageRepPropertyKey, NSScreen, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewView};
    use std::{
        cell::RefCell,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        time::Duration,
    };

    const THUMBNAIL_WIDTH: f64 = 1200.0;
    const THUMBNAIL_HEIGHT: f64 = 900.0;
    const MAX_PIXEL_WIDTH: f64 = 1600.0;
    const MAX_PIXEL_HEIGHT: f64 = 1200.0;
    const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
    const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(15);
    const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);

    thread_local! {
        static PREVIEW_WINDOW: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
    }

    fn thumbnail_scale_on_main_thread() -> Result<f64, String> {
        let marker = MainThreadMarker::new().ok_or_else(|| "MAIN_THREAD_REQUIRED".to_string())?;
        let screen_scale = NSScreen::mainScreen(marker)
            .map(|screen| screen.backingScaleFactor())
            .unwrap_or(1.0);
        let pixel_cap =
            (MAX_PIXEL_WIDTH / THUMBNAIL_WIDTH).min(MAX_PIXEL_HEIGHT / THUMBNAIL_HEIGHT);
        Ok(screen_scale.clamp(1.0, pixel_cap))
    }

    fn thumbnail_scale(app: &AppHandle) -> Result<f64, String> {
        if MainThreadMarker::new().is_some() {
            return thumbnail_scale_on_main_thread();
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = autoreleasepool(|_| thumbnail_scale_on_main_thread());
            let _ = sender.send(result);
        })
        .map_err(|error| format!("MAIN_THREAD_DISPATCH_FAILED: {error}"))?;

        receiver
            .recv_timeout(MAIN_THREAD_TIMEOUT)
            .map_err(|_| "MAIN_THREAD_TIMEOUT".to_string())?
    }

    fn thumbnail_result(
        representation: *mut QLThumbnailRepresentation,
        error: *mut NSError,
    ) -> Result<SystemPreviewSnapshot, String> {
        let representation = unsafe { Retained::retain(representation) };
        let Some(representation) = representation else {
            let detail = unsafe { error.as_ref() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "No thumbnail representation was returned".to_string());
            return Err(format!("QUICK_LOOK_GENERATION_FAILED: {detail}"));
        };

        let image = unsafe { representation.NSImage() };
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "QUICK_LOOK_PNG_CONVERSION_FAILED: no TIFF data".to_string())?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "QUICK_LOOK_PNG_CONVERSION_FAILED: invalid image data".to_string())?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or_else(|| "QUICK_LOOK_PNG_CONVERSION_FAILED: PNG encoder failed".to_string())?;
        let bytes = png.to_vec();
        if bytes.len() > MAX_PNG_BYTES {
            return Err("QUICK_LOOK_THUMBNAIL_TOO_LARGE".to_string());
        }

        Ok(SystemPreviewSnapshot {
            mime_type: "image/png",
            data_base64: STANDARD.encode(bytes),
            width: bitmap.pixelsWide().max(0) as usize,
            height: bitmap.pixelsHigh().max(0) as usize,
        })
    }

    fn generate_thumbnail_blocking(
        path: PathBuf,
        scale: f64,
    ) -> Result<SystemPreviewSnapshot, String> {
        let path = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                NSSize::new(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT),
                scale,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        let (sender, receiver) = mpsc::sync_channel(1);
        let completed = Arc::new(AtomicBool::new(false));
        let callback_completed = Arc::clone(&completed);
        let completion: RcBlock<dyn Fn(*mut QLThumbnailRepresentation, *mut NSError)> =
            RcBlock::new(move |representation, error| {
                if callback_completed.swap(true, Ordering::AcqRel) {
                    return;
                }
                let result = autoreleasepool(|_| thumbnail_result(representation, error));
                let _ = sender.send(result);
            });

        unsafe {
            generator.generateBestRepresentationForRequest_completionHandler(&request, &completion)
        };

        match receiver.recv_timeout(THUMBNAIL_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                completed.store(true, Ordering::Release);
                unsafe { generator.cancelRequest(&request) };
                Err("QUICK_LOOK_TIMEOUT".to_string())
            }
        }
    }

    pub(super) async fn generate_system_thumbnail(
        path: String,
        app: AppHandle,
        state: State<'_, WorkspaceState>,
    ) -> Result<SystemPreviewSnapshot, String> {
        let path = scoped_preview_target(&state, path)?;
        let scale = thumbnail_scale(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            autoreleasepool(|_| generate_thumbnail_blocking(path, scale))
        })
        .await
        .map_err(|error| format!("QUICK_LOOK_TASK_FAILED: {error}"))?
    }

    fn show_preview_on_main_thread(path: &Path) -> Result<(), String> {
        let marker = MainThreadMarker::new().ok_or_else(|| "MAIN_THREAD_REQUIRED".to_string())?;
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(900.0, 680.0));
        let preview = unsafe { QLPreviewView::initWithFrame(marker.alloc(), frame) }
            .ok_or_else(|| "QUICK_LOOK_VIEW_FAILED".to_string())?;
        preview.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );

        let path_string = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath_isDirectory(&path_string, path.is_dir());
        let preview_item = ProtocolObject::<dyn QLPreviewItem>::from_ref(&*url);
        unsafe {
            preview.setPreviewItem(Some(preview_item));
            preview.setShouldCloseWithWindow(true);
        }

        PREVIEW_WINDOW.with(|slot| {
            let mut slot = slot.borrow_mut();
            let window = slot.get_or_insert_with(|| {
                let window = unsafe {
                    NSWindow::initWithContentRect_styleMask_backing_defer(
                        marker.alloc(),
                        frame,
                        NSWindowStyleMask::Titled
                            | NSWindowStyleMask::Closable
                            | NSWindowStyleMask::Miniaturizable
                            | NSWindowStyleMask::Resizable,
                        NSBackingStoreType::Buffered,
                        false,
                    )
                };
                unsafe { window.setReleasedWhenClosed(false) };
                window.center();
                window
            });
            window.setContentView(Some(&preview));
            let title = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Quick Look");
            window.setTitle(&NSString::from_str(title));
            window.makeKeyAndOrderFront(None);
        });

        Ok(())
    }

    pub(super) fn open_quick_look(
        path: String,
        app: AppHandle,
        state: State<'_, WorkspaceState>,
    ) -> Result<(), String> {
        let path = scoped_preview_target(&state, path)?;
        if MainThreadMarker::new().is_some() {
            return autoreleasepool(|_| show_preview_on_main_thread(&path));
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = autoreleasepool(|_| show_preview_on_main_thread(&path));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("MAIN_THREAD_DISPATCH_FAILED: {error}"))?;

        receiver
            .recv_timeout(MAIN_THREAD_TIMEOUT)
            .map_err(|_| "MAIN_THREAD_TIMEOUT".to_string())?
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) async fn generate_system_thumbnail(
    path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<SystemPreviewSnapshot, String> {
    platform::generate_system_thumbnail(path, app, state).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn open_quick_look(
    path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    platform::open_quick_look(path, app, state)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) async fn generate_system_thumbnail(
    path: String,
    _app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<SystemPreviewSnapshot, String> {
    let _ = scoped_preview_target(&state, path)?;
    Err("QUICK_LOOK_UNAVAILABLE".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn open_quick_look(
    path: String,
    _app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _ = scoped_preview_target(&state, path)?;
    Err("QUICK_LOOK_UNAVAILABLE".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn recognizes_office_and_iwork_extensions() {
        for extension in QUICK_LOOK_EXTENSIONS {
            assert!(is_quick_look_extension(Path::new(&format!(
                "document.{extension}"
            ))));
        }
        assert!(!is_quick_look_extension(Path::new("document.md")));
    }

    #[test]
    fn preview_target_accepts_regular_files_and_iwork_bundles() {
        let root =
            std::env::temp_dir().join(format!("localview-quick-look-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("report.pages")).unwrap();
        fs::create_dir_all(root.join("ordinary-folder")).unwrap();
        fs::write(root.join("report.docx"), b"fixture").unwrap();

        assert!(validate_preview_target(&root.join("report.docx")).is_ok());
        assert!(validate_preview_target(&root.join("report.pages")).is_ok());
        assert_eq!(
            validate_preview_target(&root.join("ordinary-folder")).unwrap_err(),
            "QUICK_LOOK_UNSUPPORTED_TARGET"
        );

        fs::remove_dir_all(root).unwrap();
    }
}
