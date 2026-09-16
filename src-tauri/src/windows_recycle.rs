//! Recycle-only Shell API: never use DeleteFile, RemoveDirectory or a permanent-delete fallback.
use super::{windows_fs, CommandError};
use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, path::Path};
use windows::{
    core::HSTRING,
    Win32::{
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            BHID_Transfer, FOLDERID_RecycleBin, IShellItem, ITransferSource,
            SHCreateItemFromParsingName, SHCreateItemInKnownFolder, KF_FLAG_DEFAULT,
            SIGDN_DESKTOPABSOLUTEPARSING,
        },
    },
};

pub(super) fn recycle(path: &Path, expected_identity: &str) -> Result<String, CommandError> {
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
        .map_err(|e| CommandError::new("TRASH_FAILED", e.to_string()));
    result?;
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _com = Com;
    let file = OpenOptions::new()
        .access_mode(0x80)
        .share_mode(7)
        .custom_flags(0x02200000)
        .open(path)
        .map_err(CommandError::io)?;
    use std::os::windows::fs::MetadataExt;
    if file.metadata().map_err(CommandError::io)?.file_attributes() & 0x400 != 0
        || windows_fs::identity(&file)?.token() != expected_identity
    {
        return Err(CommandError::new(
            "TRASH_TARGET_CHANGED",
            "Recycle target changed",
        ));
    }
    let raw = path.to_string_lossy();
    let source = HSTRING::from(raw.strip_prefix("\\\\?\\").unwrap_or(&raw));
    let recycled = unsafe {
        (|| -> windows::core::Result<String> {
            let item: IShellItem = SHCreateItemFromParsingName(&source, None)?;
            let parent = item.GetParent()?;
            let transfer: ITransferSource = parent.BindToHandler(None, &BHID_Transfer)?;
            let bin: IShellItem =
                SHCreateItemInKnownFolder(&FOLDERID_RecycleBin, KF_FLAG_DEFAULT, None)?;
            let destination = transfer.RecycleItem(&item, &bin, 0)?;
            let name = destination.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING)?;
            let text = name.to_string();
            CoTaskMemFree(Some(name.0.cast()));
            text
        })()
    }
    .map_err(|e| {
        CommandError::new(
            "TRASH_FAILED",
            format!("Recycle Bin unavailable; no permanent-delete fallback: {e}"),
        )
    })?;
    drop(file);
    if path.exists() {
        return Err(CommandError::new(
            "TRASH_TARGET_CHANGED",
            "Recycle operation did not remove the source entry",
        ));
    }
    Ok(recycled)
}
