use serde::{Deserialize, Serialize};
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedPreviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn validate_embedded_preview_bounds(bounds: EmbeddedPreviewBounds) -> Result<(), String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite()) || bounds.width <= 0.0 || bounds.height <= 0.0
    {
        return Err("QUICK_LOOK_INVALID_BOUNDS".to_string());
    }
    Ok(())
}

fn accepts_generation(latest_generation: u64, generation: u64) -> bool {
    generation > latest_generation
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
        NSBitmapImageRepPropertyKey, NSScreen, NSView, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewView, QLPreviewViewStyle};
    use std::{
        cell::RefCell,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        time::Duration,
    };
    use tauri::Manager;

    const THUMBNAIL_WIDTH: f64 = 1200.0;
    const THUMBNAIL_HEIGHT: f64 = 900.0;
    const MAX_PIXEL_WIDTH: f64 = 1600.0;
    const MAX_PIXEL_HEIGHT: f64 = 1200.0;
    const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
    const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(15);
    const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);

    thread_local! {
        static PREVIEW_WINDOW: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
        static EMBEDDED_PREVIEW: RefCell<EmbeddedPreviewSlot> = const {
            RefCell::new(EmbeddedPreviewSlot {
                latest_generation: 0,
                active: None,
            })
        };
    }

    struct EmbeddedPreview {
        generation: u64,
        view: Retained<QLPreviewView>,
    }

    struct EmbeddedPreviewSlot {
        latest_generation: u64,
        active: Option<EmbeddedPreview>,
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

    pub(super) fn preview_frame(
        bounds: EmbeddedPreviewBounds,
        parent_bounds: NSRect,
    ) -> Result<NSRect, String> {
        validate_embedded_preview_bounds(bounds)?;

        let parent_width = parent_bounds.size.width.max(0.0);
        let parent_height = parent_bounds.size.height.max(0.0);
        let left = bounds.x.clamp(0.0, parent_width);
        let top = bounds.y.clamp(0.0, parent_height);
        let right = (bounds.x + bounds.width).clamp(0.0, parent_width);
        let bottom_from_top = (bounds.y + bounds.height).clamp(0.0, parent_height);
        let width = right - left;
        let height = bottom_from_top - top;

        if width <= 0.0 || height <= 0.0 {
            return Err("QUICK_LOOK_INVALID_BOUNDS".to_string());
        }

        Ok(NSRect::new(
            NSPoint::new(
                parent_bounds.origin.x + left,
                parent_bounds.origin.y + parent_height - bottom_from_top,
            ),
            NSSize::new(width, height),
        ))
    }

    fn run_on_main_thread(
        app: &AppHandle,
        operation: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        if MainThreadMarker::new().is_some() {
            return autoreleasepool(|_| operation());
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = autoreleasepool(|_| operation());
            let _ = sender.send(result);
        })
        .map_err(|error| format!("MAIN_THREAD_DISPATCH_FAILED: {error}"))?;

        receiver
            .recv_timeout(MAIN_THREAD_TIMEOUT)
            .map_err(|_| "MAIN_THREAD_TIMEOUT".to_string())?
    }

    fn main_content_view(app: &AppHandle) -> Result<Retained<NSView>, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "QUICK_LOOK_WINDOW_NOT_FOUND".to_string())?;
        let view = window
            .ns_view()
            .map_err(|error| format!("QUICK_LOOK_EMBED_FAILED: {error}"))?;
        unsafe { Retained::retain(view.cast::<NSView>()) }
            .ok_or_else(|| "QUICK_LOOK_EMBED_FAILED: invalid content view".to_string())
    }

    fn close_embedded_preview(preview: EmbeddedPreview) {
        unsafe { preview.view.close() };
        preview.view.removeFromSuperview();
    }

    fn show_embedded_preview_on_main_thread(
        app: &AppHandle,
        path: &Path,
        bounds: EmbeddedPreviewBounds,
        generation: u64,
    ) -> Result<(), String> {
        let marker = MainThreadMarker::new().ok_or_else(|| "MAIN_THREAD_REQUIRED".to_string())?;

        let is_stale = EMBEDDED_PREVIEW
            .with(|slot| !accepts_generation(slot.borrow().latest_generation, generation));
        if is_stale {
            return Ok(());
        }

        let parent = main_content_view(app)?;
        let frame = preview_frame(bounds, parent.bounds())?;
        let preview = unsafe {
            QLPreviewView::initWithFrame_style(marker.alloc(), frame, QLPreviewViewStyle::Normal)
        }
        .ok_or_else(|| "QUICK_LOOK_EMBED_FAILED: preview view init failed".to_string())?;

        let path_string = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath_isDirectory(&path_string, path.is_dir());
        let preview_item = ProtocolObject::<dyn QLPreviewItem>::from_ref(&*url);
        unsafe {
            preview.setPreviewItem(Some(preview_item));
            preview.setShouldCloseWithWindow(true);
        }

        EMBEDDED_PREVIEW.with(|slot| {
            let mut slot = slot.borrow_mut();
            if !accepts_generation(slot.latest_generation, generation) {
                unsafe { preview.close() };
                return;
            }
            if let Some(active) = slot.active.take() {
                close_embedded_preview(active);
            }
            parent.addSubview(&preview);
            if let Some(window) = parent.window() {
                window.makeFirstResponder(Some(&preview));
            }
            slot.latest_generation = generation;
            slot.active = Some(EmbeddedPreview {
                generation,
                view: preview,
            });
        });

        Ok(())
    }

    fn resize_embedded_preview_on_main_thread(
        app: &AppHandle,
        bounds: EmbeddedPreviewBounds,
        generation: u64,
    ) -> Result<(), String> {
        validate_embedded_preview_bounds(bounds)?;
        let parent = main_content_view(app)?;
        let frame = preview_frame(bounds, parent.bounds())?;
        EMBEDDED_PREVIEW.with(|slot| {
            let slot = slot.borrow();
            if let Some(active) = slot
                .active
                .as_ref()
                .filter(|active| active.generation == generation)
            {
                active.view.setFrame(frame);
            }
        });
        Ok(())
    }

    fn hide_embedded_preview_on_main_thread(generation: u64) -> Result<(), String> {
        MainThreadMarker::new().ok_or_else(|| "MAIN_THREAD_REQUIRED".to_string())?;
        EMBEDDED_PREVIEW.with(|slot| {
            let mut slot = slot.borrow_mut();
            slot.latest_generation = slot.latest_generation.max(generation);
            if slot
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
            {
                if let Some(active) = slot.active.take() {
                    close_embedded_preview(active);
                }
            }
        });
        Ok(())
    }

    pub(super) fn show_embedded_quick_look(
        path: String,
        bounds: EmbeddedPreviewBounds,
        generation: u64,
        app: AppHandle,
        state: State<'_, WorkspaceState>,
    ) -> Result<(), String> {
        validate_embedded_preview_bounds(bounds)?;
        let path = scoped_preview_target(&state, path)?;
        let main_app = app.clone();
        run_on_main_thread(&app, move || {
            show_embedded_preview_on_main_thread(&main_app, &path, bounds, generation)
        })
    }

    pub(super) fn resize_embedded_quick_look(
        bounds: EmbeddedPreviewBounds,
        generation: u64,
        app: AppHandle,
    ) -> Result<(), String> {
        validate_embedded_preview_bounds(bounds)?;
        let main_app = app.clone();
        run_on_main_thread(&app, move || {
            resize_embedded_preview_on_main_thread(&main_app, bounds, generation)
        })
    }

    pub(super) fn hide_embedded_quick_look(generation: u64, app: AppHandle) -> Result<(), String> {
        run_on_main_thread(&app, move || {
            hide_embedded_preview_on_main_thread(generation)
        })
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
pub(crate) fn show_embedded_quick_look(
    path: String,
    bounds: EmbeddedPreviewBounds,
    generation: u64,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    platform::show_embedded_quick_look(path, bounds, generation, app, state)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn resize_embedded_quick_look(
    bounds: EmbeddedPreviewBounds,
    generation: u64,
    app: AppHandle,
) -> Result<(), String> {
    platform::resize_embedded_quick_look(bounds, generation, app)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn hide_embedded_quick_look(generation: u64, app: AppHandle) -> Result<(), String> {
    platform::hide_embedded_quick_look(generation, app)
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
pub(crate) fn show_embedded_quick_look(
    path: String,
    bounds: EmbeddedPreviewBounds,
    _generation: u64,
    _app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _ = scoped_preview_target(&state, path)?;
    validate_embedded_preview_bounds(bounds)?;
    Err("QUICK_LOOK_UNAVAILABLE".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn resize_embedded_quick_look(
    bounds: EmbeddedPreviewBounds,
    _generation: u64,
    _app: AppHandle,
) -> Result<(), String> {
    validate_embedded_preview_bounds(bounds)?;
    Err("QUICK_LOOK_UNAVAILABLE".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn hide_embedded_quick_look(_generation: u64, _app: AppHandle) -> Result<(), String> {
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

    #[test]
    fn embedded_bounds_reject_non_finite_or_empty_values() {
        assert!(validate_embedded_preview_bounds(EmbeddedPreviewBounds {
            x: 12.0,
            y: 24.0,
            width: 640.0,
            height: 480.0,
        })
        .is_ok());
        for bounds in [
            EmbeddedPreviewBounds {
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            EmbeddedPreviewBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 100.0,
            },
            EmbeddedPreviewBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: f64::INFINITY,
            },
        ] {
            assert_eq!(
                validate_embedded_preview_bounds(bounds).unwrap_err(),
                "QUICK_LOOK_INVALID_BOUNDS"
            );
        }
    }

    #[test]
    fn embedded_generation_only_moves_forward() {
        assert!(accepts_generation(10, 11));
        assert!(!accepts_generation(10, 10));
        assert!(!accepts_generation(10, 9));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn embedded_frame_converts_top_left_coordinates_and_clamps_to_parent() {
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let parent = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1000.0, 800.0));
        let frame = platform::preview_frame(
            EmbeddedPreviewBounds {
                x: 250.0,
                y: 88.0,
                width: 900.0,
                height: 760.0,
            },
            parent,
        )
        .unwrap();

        assert_eq!(frame.origin.x, 250.0);
        assert_eq!(frame.origin.y, 0.0);
        assert_eq!(frame.size.width, 750.0);
        assert_eq!(frame.size.height, 712.0);
    }
}
