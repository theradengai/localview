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
    ("Window", "窗口"),
    ("Minimize", "最小化"),
    ("Zoom", "缩放"),
    ("Bring All to Front", "全部置于顶层"),
    ("Help", "帮助"),
];

fn menu_label(text: &str, language: &str) -> Option<&'static str> {
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

#[tauri::command]
pub fn set_ui_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    if language != "en" && language != "zh-CN" {
        return Err("Unsupported UI language".into());
    }
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        translate_items(menu.items().map_err(|e| e.to_string())?, &language)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
