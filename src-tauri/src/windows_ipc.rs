//! Keep the native IPC key exclusively in trusted top-level Windows app frames.
//! Document previews may execute JavaScript, but never receive a usable transport.
pub(super) fn script() -> String {
    include_str!("windows_ipc.js").replace(
        "__LOCALVIEW_DEV__",
        if cfg!(debug_assertions) {
            "true"
        } else {
            "false"
        },
    )
}
