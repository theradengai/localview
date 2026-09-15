// Change only existing labels. IDs, native actions, accelerators and the two-phase
// application quit handler remain owned by the original menu construction.
const LABELS: &[(&str, &str)] = &[
    ("About LocalView", "关于 LocalView"),
    ("Services", "服务"),
    ("Hide LocalView", "隐藏 LocalView"),
    ("Hide Others", "隐藏其他"),
    ("Show All", "显示全部"),
    ("Quit LocalView", "退出 LocalView"),
    ("File", "文件"),
    ("Close Window", "关闭窗口"),
    ("Print…", "打印…"),
    ("Edit", "编辑"),
    ("Undo", "撤销"),
    ("Redo", "重做"),
    ("Cut", "剪切"),
    ("Copy", "复制"),
    ("Paste", "粘贴"),
    ("Select All", "全选"),
    ("View", "视图"),
    ("Enter Full Screen", "进入全屏"),
    ("Toggle Full Screen", "切换全屏"),
    ("Window", "窗口"),
    ("Minimize", "最小化"),
    ("Zoom", "缩放"),
    ("Bring All to Front", "全部置于顶层"),
    ("Help", "帮助"),
];

fn menu_label(text: &str, language: &str) -> Option<&'static str> {
    // Tauri can use the lowercase Cargo package name in these predefined labels.
    let text = match text {
        "About localview" => "About LocalView",
        "Hide localview" => "Hide LocalView",
        _ => text,
    };
    LABELS.iter().find_map(|(en, zh)| {
        if text == *en || text == *zh {
            Some(if language == "zh-CN" { *zh } else { *en })
        } else {
            None
        }
    })
}

#[cfg(target_os = "macos")]
fn translate_items(
    items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>,
    language: &str,
) -> tauri::Result<()> {
    use tauri::menu::MenuItemKind;
    for item in items {
        match item {
            MenuItemKind::Submenu(item) => {
                if let Some(text) = menu_label(&item.text()?, language) {
                    item.set_text(text)?;
                }
                translate_items(item.items()?, language)?;
            }
            MenuItemKind::MenuItem(item) => {
                if let Some(text) = menu_label(&item.text()?, language) {
                    item.set_text(text)?;
                }
            }
            MenuItemKind::Predefined(item) => {
                if let Some(text) = menu_label(&item.text()?, language) {
                    item.set_text(text)?;
                }
            }
            MenuItemKind::Check(_) | MenuItemKind::Icon(_) => {}
        }
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct LanguageSnapshot {
    preference: String,
    revision: u64,
}

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum LanguageRequest {
    Initialize { preference: String },
    Select { preference: String },
    Menu { language: String, revision: u64 },
}

#[derive(Default)]
struct LanguageSyncState(std::sync::Mutex<Option<LanguageSnapshot>>);

fn validate_preference(preference: &str) -> Result<(), String> {
    match preference {
        "system" | "en" | "zh-CN" => Ok(()),
        _ => Err("Unsupported UI language preference".into()),
    }
}

fn select_preference(
    current: &mut Option<LanguageSnapshot>,
    preference: String,
    initialize: bool,
) -> Result<LanguageSnapshot, String> {
    validate_preference(&preference)?;
    if initialize {
        if let Some(snapshot) = current {
            return Ok(snapshot.clone());
        }
    }
    let revision = match current {
        Some(snapshot) => snapshot
            .revision
            .checked_add(1)
            .ok_or("Language revision overflow")?,
        None => 0,
    };
    let snapshot = LanguageSnapshot {
        preference,
        revision,
    };
    *current = Some(snapshot.clone());
    Ok(snapshot)
}

// Async commands keep menu dispatch off the macOS event-loop thread. The process-wide
// mutex orders selections and guards menu updates against stale window notifications.
#[tauri::command]
pub async fn set_ui_language(
    app: tauri::AppHandle,
    request: LanguageRequest,
) -> Result<LanguageSnapshot, String> {
    use tauri::{Emitter, Manager};
    // Manager::manage inserts this type once; subsequent callers keep the existing state.
    app.manage(LanguageSyncState::default());
    let state = app.state::<LanguageSyncState>();
    let mut current = state.0.lock().map_err(|_| "Language state lock poisoned")?;
    match request {
        LanguageRequest::Initialize { preference } => {
            select_preference(&mut current, preference, true)
        }
        LanguageRequest::Select { preference } => {
            let snapshot = select_preference(&mut current, preference, false)?;
            drop(current);
            app.emit("localview-ui-language", &snapshot)
                .map_err(|error| error.to_string())?;
            Ok(snapshot)
        }
        LanguageRequest::Menu { language, revision } => {
            if language != "en" && language != "zh-CN" {
                return Err("Unsupported UI language".into());
            }
            let snapshot = current.as_ref().ok_or("Language state not initialized")?;
            if snapshot.revision == revision
                && (snapshot.preference == "system" || snapshot.preference == language)
            {
                #[cfg(target_os = "macos")]
                if let Some(menu) = app.menu() {
                    translate_items(menu.items().map_err(|error| error.to_string())?, &language)
                        .map_err(|error| error.to_string())?;
                }
            }
            Ok(snapshot.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_native_menu_labels_are_translated() {
        assert_eq!(menu_label("About localview", "zh-CN"), Some("关于 LocalView"));
        assert_eq!(menu_label("Hide localview", "zh-CN"), Some("隐藏 LocalView"));
        assert_eq!(menu_label("Toggle Full Screen", "zh-CN"), Some("切换全屏"));
        assert_eq!(menu_label("About localview", "en"), Some("About LocalView"));
    }

    #[test]
    fn native_preference_has_one_monotonic_authority() {
        let mut state = None;
        let first = select_preference(&mut state, "zh-CN".into(), true).unwrap();
        assert_eq!(first.revision, 0);
        let next = select_preference(&mut state, "en".into(), false).unwrap();
        assert_eq!(next.revision, 1);
        let late_window = select_preference(&mut state, "zh-CN".into(), true).unwrap();
        assert_eq!(late_window.preference, "en");
        assert_eq!(late_window.revision, 1);
        let final_choice = select_preference(&mut state, "zh-CN".into(), false).unwrap();
        assert_eq!(final_choice.revision, 2);
        assert!(select_preference(&mut state, "invalid".into(), false).is_err());
        assert_eq!(state.unwrap().revision, 2);
    }

    #[test]
    fn labels_round_trip_without_changing_unknown_text() {
        for (en, zh) in LABELS {
            assert_eq!(menu_label(en, "zh-CN"), Some(*zh));
            assert_eq!(menu_label(zh, "en"), Some(*en));
        }
        assert_eq!(menu_label("My File.md", "zh-CN"), None);
        assert_eq!(menu_label("LocalView", "zh-CN"), None);
    }
}
