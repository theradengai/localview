use super::*;

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGES: usize = 8;
static NEXT_IMAGE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PastedImage {
    mime_type: String,
    bytes: Vec<u8>,
}

fn image_extension(image: &PastedImage) -> Result<&'static str, CommandError> {
    let bytes = &image.bytes;
    let extension = match image.mime_type.as_str() {
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "jpg",
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => "gif",
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "webp",
        _ => {
            return Err(CommandError::new(
                "INVALID_PASTED_IMAGE",
                "图片格式无效或不受支持",
            ))
        }
    };
    Ok(extension)
}

fn save_images_with_hook<F: FnOnce()>(
    state: &WorkspaceState,
    document_path: &Path,
    workspace_generation: u64,
    images: &[PastedImage],
    before_write: F,
) -> Result<Vec<String>, CommandError> {
    if images.is_empty()
        || images.len() > MAX_IMAGES
        || images.iter().map(|image| image.bytes.len()).sum::<usize>() > MAX_IMAGE_BYTES
    {
        return Err(CommandError::new(
            "PASTED_IMAGE_LIMIT",
            "一次最多粘贴 8 张图片，总大小不能超过 10 MB",
        ));
    }
    let extensions = images
        .iter()
        .map(image_extension)
        .collect::<Result<Vec<_>, _>>()?;

    #[cfg(not(unix))]
    {
        let _ = (
            state,
            document_path,
            workspace_generation,
            before_write,
            extensions,
        );
        Err(CommandError::new(
            "IMAGE_PASTE_UNSUPPORTED",
            "当前平台不支持保存粘贴图片",
        ))
    }
    #[cfg(unix)]
    {
        let (root, generation) =
            active_workspace_capability_with_generation(state).map_err(CommandError::legacy)?;
        if generation != workspace_generation || file_kind(document_path, false) != "md" {
            return Err(CommandError::new(
                "IMAGE_PASTE_CONTEXT_CHANGED",
                "工作区或 Markdown 文档已经变化",
            ));
        }
        let parent_path = document_path
            .parent()
            .ok_or_else(|| CommandError::new("INVALID_PATH", "文档路径无效"))?;
        // Traverse from this window's pinned root, rejecting symlinks and bundle interiors.
        let parent = open_move_directory(
            &root,
            parent_path,
            "IMAGE_PARENT_CHANGED",
            "IMAGE_BUNDLE_BOUNDARY",
        )?;
        let name = document_path
            .file_name()
            .ok_or_else(|| CommandError::new("INVALID_PATH", "文档路径无效"))?;
        let document = unix_fs::openat(
            &parent.directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(command_errno)?;
        let document_stat = unix_fs::fstat(&document).map_err(command_errno)?;
        if !FileType::from_raw_mode(document_stat.st_mode).is_file() {
            return Err(CommandError::new(
                "INVALID_PATH",
                "Markdown 文档不是普通文件",
            ));
        }
        before_write();
        // Keep the workspace generation stable until every result has been checked.
        let context = state
            .context
            .lock()
            .map_err(|_| CommandError::new("WORKSPACE_CHANGED", "工作区状态不可用"))?;
        if context.generation != generation {
            return Err(CommandError::new(
                "IMAGE_PASTE_CONTEXT_CHANGED",
                "工作区已经变化",
            ));
        }
        let validate_document = || -> Result<(), CommandError> {
            validate_directory_identity(&root.path, &root.directory, "WORKSPACE_ROOT_CHANGED")
                .map_err(CommandError::legacy)?;
            validate_directory_identity(parent_path, &parent.directory, "IMAGE_PARENT_CHANGED")
                .map_err(CommandError::legacy)?;
            let current = unix_fs::statat(&parent.directory, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(command_errno)?;
            if current.st_dev != document_stat.st_dev
                || current.st_ino != document_stat.st_ino
                || !FileType::from_raw_mode(current.st_mode).is_file()
            {
                return Err(CommandError::new(
                    "IMAGE_DOCUMENT_CHANGED",
                    "文档已被移动或替换，已停止粘贴图片",
                ));
            }
            Ok(())
        };
        validate_document()?;
        match unix_fs::mkdirat(
            &parent.directory,
            "assets",
            Mode::RWXU | Mode::RGRP | Mode::XGRP | Mode::ROTH | Mode::XOTH,
        ) {
            Ok(()) | Err(Errno::EXIST) => {}
            Err(error) => return Err(command_errno(error)),
        }
        let assets_path = parent_path.join("assets");
        let assets = open_move_directory(
            &root,
            &assets_path,
            "IMAGE_ASSETS_UNAVAILABLE",
            "IMAGE_BUNDLE_BOUNDARY",
        )?;
        let mut sources = Vec::new();
        for (image, extension) in images.iter().zip(extensions) {
            validate_document()?;
            validate_directory_identity(&assets_path, &assets.directory, "IMAGE_ASSETS_CHANGED")
                .map_err(CommandError::legacy)?;
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let id = NEXT_IMAGE.fetch_add(1, Ordering::Relaxed);
            let filename = format!(
                "screenshot-{timestamp}-{}-{id}.{extension}",
                std::process::id()
            );
            let temporary = format!(".localview-{filename}.tmp");
            let fd = unix_fs::openat(
                &assets.directory,
                temporary.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::ROTH,
            )
            .map_err(command_errno)?;
            let mut file = fs::File::from(fd);
            let result = (|| -> Result<(), CommandError> {
                file.write_all(&image.bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(CommandError::io)?;
                validate_document()?;
                validate_directory_identity(
                    &assets_path,
                    &assets.directory,
                    "IMAGE_ASSETS_CHANGED",
                )
                .map_err(CommandError::legacy)?;
                unix_fs::renameat_with(
                    &assets.directory,
                    temporary.as_str(),
                    &assets.directory,
                    filename.as_str(),
                    RenameFlags::NOREPLACE,
                )
                .map_err(command_errno)?;
                validate_document()?;
                validate_directory_identity(
                    &assets_path,
                    &assets.directory,
                    "IMAGE_ASSETS_CHANGED",
                )
                .map_err(CommandError::legacy)?;
                Ok(())
            })();
            if result.is_err() {
                // Remove only our temporary inode; never remove or overwrite an existing attachment.
                if let (Ok(created), Ok(current)) = (
                    unix_fs::fstat(&file),
                    unix_fs::statat(
                        &assets.directory,
                        temporary.as_str(),
                        AtFlags::SYMLINK_NOFOLLOW,
                    ),
                ) {
                    if created.st_dev == current.st_dev && created.st_ino == current.st_ino {
                        let _ = unix_fs::unlinkat(
                            &assets.directory,
                            temporary.as_str(),
                            AtFlags::empty(),
                        );
                    }
                }
            }
            result?;
            sources.push(format!("assets/{filename}"));
        }
        Ok(sources)
    }
}

#[tauri::command]
pub(crate) async fn save_pasted_images(
    document_path: String,
    workspace_generation: u64,
    images: Vec<PastedImage>,
    window: WebviewWindow,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Vec<String>, CommandError> {
    let state = workspace_for_window(&registry, &window).map_err(CommandError::legacy)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_images_with_hook(
            &state,
            Path::new(&document_path),
            workspace_generation,
            &images,
            || {},
        )
    })
    .await
    .map_err(|error| CommandError::new("IMAGE_PASTE_FAILED", error.to_string()))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture {
        root: PathBuf,
        state: WorkspaceState,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "localview-image-paste-{}-{}",
                std::process::id(),
                NEXT_IMAGE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            fs::create_dir(root.join("docs")).unwrap();
            fs::write(root.join("docs/笔记.md"), b"original markdown").unwrap();
            let state = WorkspaceState {
                context: Mutex::new(WorkspaceContext {
                    root: Some(open_workspace_root(&root).unwrap()),
                    generation: 1,
                    asset_scope: "test".into(),
                    watcher: None,
                }),
                ..Default::default()
            };
            Self { root, state }
        }
        fn document(&self) -> PathBuf {
            self.root.join("docs/笔记.md")
        }
        fn paste(&self) -> Result<Vec<String>, CommandError> {
            save_images_with_hook(&self.state, &self.document(), 1, &[png()], || {})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn png() -> PastedImage {
        PastedImage {
            mime_type: "image/png".into(),
            bytes: b"\x89PNG\r\n\x1a\nimage payload".to_vec(),
        }
    }

    #[test]
    fn writes_unique_relative_attachments_without_changing_markdown_or_existing_files() {
        let f = Fixture::new();
        fs::create_dir(f.root.join("docs/assets")).unwrap();
        fs::write(f.root.join("docs/assets/keep.png"), b"keep").unwrap();
        let first = f.paste().unwrap();
        let second = f.paste().unwrap();
        assert_ne!(first, second);
        for source in first.iter().chain(&second) {
            assert!(source.starts_with("assets/screenshot-") && source.ends_with(".png"));
            assert_eq!(
                fs::read(f.root.join("docs").join(source)).unwrap(),
                png().bytes
            );
        }
        assert_eq!(fs::read(f.document()).unwrap(), b"original markdown");
        assert_eq!(
            fs::read(f.root.join("docs/assets/keep.png")).unwrap(),
            b"keep"
        );
        assert_eq!(fs::read_dir(f.root.join("docs/assets")).unwrap().count(), 3);
    }

    #[test]
    fn rejects_other_window_workspaces_and_stale_generations() {
        let a = Fixture::new();
        let b = Fixture::new();
        assert!(save_images_with_hook(&a.state, &b.document(), 1, &[png()], || {}).is_err());
        assert!(save_images_with_hook(&a.state, &a.document(), 2, &[png()], || {}).is_err());
        assert!(!a.root.join("docs/assets").exists());
        assert!(!b.root.join("docs/assets").exists());
    }

    #[test]
    fn rejects_assets_symlinks_and_regular_file_collisions() {
        let f = Fixture::new();
        let outside = Fixture::new();
        let assets = f.root.join("docs/assets");
        symlink(&outside.root, &assets).unwrap();
        assert!(f.paste().is_err());
        assert_eq!(fs::read_dir(&outside.root).unwrap().count(), 1);
        fs::remove_file(&assets).unwrap();
        fs::write(&assets, b"do not replace").unwrap();
        assert!(f.paste().is_err());
        assert_eq!(fs::read(assets).unwrap(), b"do not replace");
    }

    #[test]
    fn rejects_document_symlinks_bundle_interiors_and_traversal() {
        let f = Fixture::new();
        let linked = f.root.join("linked.md");
        symlink(f.document(), &linked).unwrap();
        assert!(save_images_with_hook(&f.state, &linked, 1, &[png()], || {}).is_err());
        fs::create_dir(f.root.join("a.pages")).unwrap();
        fs::write(f.root.join("a.pages/doc.md"), b"original").unwrap();
        assert!(save_images_with_hook(
            &f.state,
            &f.root.join("a.pages/doc.md"),
            1,
            &[png()],
            || {}
        )
        .is_err());
        assert!(save_images_with_hook(
            &f.state,
            &f.root.join("docs/../docs/笔记.md"),
            1,
            &[png()],
            || {}
        )
        .is_err());
    }

    #[test]
    fn rejects_changed_parent_document_and_workspace_before_writing() {
        let f = Fixture::new();
        assert!(
            save_images_with_hook(&f.state, &f.document(), 1, &[png()], || {
                fs::rename(f.root.join("docs"), f.root.join("old-docs")).unwrap();
                fs::create_dir(f.root.join("docs")).unwrap();
            })
            .is_err()
        );
        assert!(!f.root.join("docs/assets").exists());
        let f = Fixture::new();
        assert!(
            save_images_with_hook(&f.state, &f.document(), 1, &[png()], || {
                fs::rename(f.document(), f.root.join("previous.md")).unwrap();
                fs::write(f.document(), b"external replacement").unwrap();
            })
            .is_err()
        );
        assert!(!f.root.join("docs/assets").exists());
        let f = Fixture::new();
        assert!(
            save_images_with_hook(&f.state, &f.document(), 1, &[png()], || {
                f.state.context.lock().unwrap().generation = 2;
            })
            .is_err()
        );
        assert!(!f.root.join("docs/assets").exists());
    }

    #[test]
    fn validates_entire_batch_before_creating_any_files() {
        let f = Fixture::new();
        let invalid = PastedImage {
            mime_type: "image/png".into(),
            bytes: b"<script>bad</script>".to_vec(),
        };
        assert!(
            save_images_with_hook(&f.state, &f.document(), 1, &[png(), invalid], || {}).is_err()
        );
        let oversized = PastedImage {
            mime_type: "image/png".into(),
            bytes: vec![0; MAX_IMAGE_BYTES + 1],
        };
        assert!(save_images_with_hook(&f.state, &f.document(), 1, &[oversized], || {}).is_err());
        let too_many = (0..9).map(|_| png()).collect::<Vec<_>>();
        assert!(save_images_with_hook(&f.state, &f.document(), 1, &too_many, || {}).is_err());
        assert!(!f.root.join("docs/assets").exists());
    }
}
