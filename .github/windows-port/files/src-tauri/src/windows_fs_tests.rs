use super::*;
struct Fixture { root: PathBuf, state: WorkspaceState }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("localview-win-{}-中文 space", unique()));
        fs::create_dir(&root).unwrap();
        let state = WorkspaceState::default();
        commit_workspace_root(&state, open_workspace_root(&root).unwrap(), None).unwrap();
        Self { root, state }
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
#[test]
fn windows_names_reject_devices_streams_and_ambiguous_names() {
    for name in ["CON", "con.md", "NUL.txt", "LPT1", "COM¹.md", "a:stream", "a.", "a ", "a?b", "..", "a\\b"] {
        assert!(validate_name(name).is_err(), "accepted {name}");
    }
    for name in ["正文.md", "COM10.md", "normal space.md", "résumé.txt"] { validate_name(name).unwrap(); }
}
#[test]
fn windows_direct_create_read_save_preserves_crlf_and_detects_conflict() {
    let f=Fixture::new();
    let created=create_markdown_file_impl(&f.state,&f.root,"原文").unwrap();
    let path=Path::new(&created.entry.path);
    let text="# 原文\r\n\r\nHello\r\n";
    let version=write_text(&f.state,path,text,&created.snapshot.version).unwrap();
    assert_eq!(read_bytes(&f.state,path).unwrap(),text.as_bytes());
    assert_eq!(read_text_file_impl(&f.state,path).unwrap().version,version);
    assert!(create_markdown_file_impl(&f.state,&f.root,"原文").is_err());
    fs::write(path,"External editor").unwrap();
    assert_eq!(write_text(&f.state,path,"Overwrite?",&version).unwrap_err().code,"EXTERNAL_CHANGE");
    assert_eq!(fs::read_to_string(path).unwrap(),"External editor");
}
#[test]
fn windows_directory_move_rename_and_reconcile_keep_files() {
    let f=Fixture::new();
    let folder=create_directory_impl(&f.state,&f.root,"Folder").unwrap();
    let file=create_markdown_file_impl(&f.state,&f.root,"原文.md").unwrap();
    let moved=prepare_move(&f.state,Path::new(&file.entry.path),Path::new(&folder.path)).unwrap();
    move_entry(&f.state,&moved).unwrap();
    assert_eq!(reconcile_move(&f.state,&moved).unwrap().outcome,MoveReconciliationOutcome::Destination);
    let renamed=prepare_rename(&f.state,Path::new(&moved.destination_path),"Renamed.md").unwrap();
    rename_entry(&f.state,&renamed).unwrap();
    assert_eq!(reconcile_rename(&f.state,&renamed).unwrap().outcome,RenameReconciliationOutcome::Destination);
    assert!(Path::new(&renamed.destination_path).is_file());
    let back=prepare_move(&f.state,Path::new(&renamed.destination_path),&f.root).unwrap();
    move_entry(&f.state,&back).unwrap();
    assert!(f.root.join("Renamed.md").is_file());
}
#[test]
fn windows_no_overwrite_or_root_mutation() {
    let f=Fixture::new();fs::create_dir(f.root.join("a")).unwrap();fs::create_dir(f.root.join("b")).unwrap();
    fs::write(f.root.join("a/note.md"),"source").unwrap();fs::write(f.root.join("b/note.md"),"destination").unwrap();
    assert!(prepare_move(&f.state,&f.root.join("a/note.md"),&f.root.join("b")).is_err());
    assert!(prepare_rename(&f.state,&f.root,"new").is_err());
    assert!(prepare_trash(&f.state,&f.root).is_err());
    assert!(prepare_move(&f.state,&f.root.join("a"),&f.root.join("a")).is_err());
    assert_eq!(fs::read_to_string(f.root.join("b/note.md")).unwrap(),"destination");
}
#[test]
fn windows_move_rejects_late_collision_and_replaced_candidate() {
    let f=Fixture::new();fs::create_dir(f.root.join("dst")).unwrap();fs::write(f.root.join("x.md"),"original").unwrap();
    let c=prepare_move(&f.state,&f.root.join("x.md"),&f.root.join("dst")).unwrap();
    fs::write(f.root.join("dst/x.md"),"never overwrite").unwrap();assert!(move_entry(&f.state,&c).is_err());
    fs::remove_file(f.root.join("dst/x.md")).unwrap();
    fs::rename(f.root.join("x.md"),f.root.join("old.md")).unwrap();fs::write(f.root.join("x.md"),"replacement").unwrap();
    assert_eq!(move_entry(&f.state,&c).unwrap_err().code,"MOVE_SOURCE_CHANGED");
    assert_eq!(fs::read_to_string(f.root.join("x.md")).unwrap(),"replacement");
}
#[test]
fn windows_stale_workspace_preserves_draft_and_target() {
    let f=Fixture::new();fs::write(f.root.join("note.md"),"saved").unwrap();
    let c=prepare_rename(&f.state,&f.root.join("note.md"),"new.md").unwrap();
    commit_workspace_root(&f.state,open_workspace_root(&f.root).unwrap(),None).unwrap();
    assert!(rename_entry(&f.state,&c).is_err());assert!(f.root.join("note.md").exists());
}
#[test]
fn windows_save_rejects_replacement_at_commit() {
    let f=Fixture::new();let path=f.root.join("draft.md");fs::write(&path,"old").unwrap();
    let outcome=write_text_with_hook(&f.state,&path,"draft",&version_for_bytes(b"old"),|| {
        fs::rename(&path,f.root.join("old.md")).unwrap();fs::write(&path,"external").unwrap();
    });
    assert_eq!(outcome.unwrap_err().code,"EXTERNAL_CHANGE");assert_eq!(fs::read_to_string(path).unwrap(),"external");
}
#[test]
fn windows_reparse_ancestors_fail_closed_and_watch_events_keep_drive() {
    let f=Fixture::new();let outside=std::env::temp_dir().join(format!("localview-outside-{}",unique()));fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.md"),"not authorized").unwrap();let link=f.root.join("junction");
    let status=std::process::Command::new("cmd.exe").args(["/C","mklink","/J"]).arg(&link).arg(&outside).status().unwrap();assert!(status.success());
    assert!(read_bytes(&f.state,&link.join("private.md")).is_err());assert!(create_markdown_file_impl(&f.state,&link,"new").is_err());
    assert!(!outside.join("new.md").exists());fs::remove_dir(&link).unwrap();fs::remove_dir_all(outside).unwrap();
    let canonical=fs::canonicalize(&f.root).unwrap();assert_eq!(event_path(&canonical,&f.root.join("removed.md")).unwrap(),canonical.join("removed.md"));
}
#[test]
fn windows_image_attachments_are_unique_and_stay_in_workspace() {
    let f=Fixture::new();let path=f.root.join("note.md");fs::write(&path,"unchanged").unwrap();
    let generation=active_workspace_snapshot(&f.state).unwrap().1;
    let bytes=b"\x89PNG\r\n\x1a\nsynthetic";
    let a=save_images(&f.state,&path,generation,&[("png",bytes)],||{}).unwrap();
    let b=save_images(&f.state,&path,generation,&[("png",bytes)],||{}).unwrap();assert_ne!(a,b);
    assert_eq!(fs::read(f.root.join(&a[0])).unwrap(),bytes);assert_eq!(fs::read_to_string(path).unwrap(),"unchanged");
}
#[test]
fn windows_local_assets_deny_streams_and_outside_paths() {
    let f=Fixture::new();fs::write(f.root.join("test.md"),"content").unwrap();
    assert!(read_bytes(&f.state,&f.root.join("test.md:secret")).is_err());
    assert!(read_bytes(&f.state,&f.root.join("../anything.md")).is_err());
    assert!(drive_path(Path::new("\\\\server\\share\\file.md")).is_err());
    assert!(argument_to_path(f.root.join("test.md").to_string_lossy().into_owned()).is_some());
}
#[test]
#[ignore = "explicit disposable Windows Recycle Bin integration; never run against user files"]
fn windows_recycle_bin_real_fixture() {
    let f=Fixture::new();let path=f.root.join("disposable.txt");fs::write(&path,"LocalView synthetic recycle fixture").unwrap();
    let c=prepare_trash(&f.state,&path).unwrap();let result=trash(&f.state,&c).unwrap();
    assert!(!path.exists());assert!(!result.trashed_path.is_empty());
    println!("Recycled disposable item: {}",result.trashed_path);
}
