use super::super::storage::{atomic_write, InstallLock};
use super::*;
use std::io::Cursor;
use zip::write::SimpleFileOptions;

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn rejects_cross_platform_zip_slip_and_ads() {
    for path in [
        "../evil",
        "/etc/passwd",
        "a/../../evil",
        "C:\\evil",
        "a\\b",
        "file:stream",
        "CON.txt",
        "dir/com1.log",
        "trailing.",
        "a\0b",
    ] {
        assert!(safe_entry_path(path).is_err(), "accepted {path}");
    }
    assert_eq!(
        safe_entry_path("mods/client.jar").unwrap(),
        PathBuf::from("mods/client.jar")
    );
}

#[test]
fn extracts_regular_files_and_checks_actual_size() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("archive.zip");
    fs::write(
        &zip,
        archive(&[("mods/a.txt", b"hello"), ("config/b.txt", b"world")]),
    )
    .unwrap();
    let target = temp.path().join("content");
    let cancel = AtomicBool::new(false);
    extract_verified_zip(&zip, &target, 10, &cancel, |_| {}).unwrap();
    assert_eq!(fs::read(target.join("mods/a.txt")).unwrap(), b"hello");
    assert_eq!(fs::read(target.join("config/b.txt")).unwrap(), b"world");
    assert!(fs::symlink_metadata(target.join("mods"))
        .unwrap()
        .file_type()
        .is_dir());
}

#[test]
fn rejects_declared_size_mismatch_before_writing_content() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("archive.zip");
    fs::write(&zip, archive(&[("a.txt", b"hello")])).unwrap();
    let target = temp.path().join("content");
    let error =
        extract_verified_zip(&zip, &target, 4, &AtomicBool::new(false), |_| {}).unwrap_err();
    assert_eq!(error.code, ErrorCode::Integrity);
    assert!(!target.join("a.txt").exists());
}

#[test]
fn rejects_symlinks_even_inside_destination() {
    let temp = tempfile::tempdir().unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("link", "target", SimpleFileOptions::default())
        .unwrap();
    let zip = temp.path().join("archive.zip");
    fs::write(&zip, writer.finish().unwrap().into_inner()).unwrap();
    let error = extract_verified_zip(
        &zip,
        &temp.path().join("content"),
        6,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeArchive);
}

#[test]
fn rejects_duplicate_case_insensitive_paths() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("archive.zip");
    fs::write(&zip, archive(&[("Mods/a.txt", b"a"), ("mods/a.txt", b"b")])).unwrap();
    let error = extract_verified_zip(
        &zip,
        &temp.path().join("content"),
        2,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeArchive);
}

#[test]
fn cancellation_does_not_extract() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("archive.zip");
    fs::write(&zip, archive(&[("a.txt", b"a")])).unwrap();
    let error = extract_verified_zip(
        &zip,
        &temp.path().join("content"),
        1,
        &AtomicBool::new(true),
        |_| {},
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
}

#[test]
fn filesystem_lock_excludes_second_writer() {
    let temp = tempfile::tempdir().unwrap();
    let _lock = InstallLock::acquire(temp.path()).unwrap();
    let error = InstallLock::acquire(temp.path())
        .err()
        .expect("lock must be exclusive");
    assert_eq!(error.code, ErrorCode::Busy);
}

#[test]
fn atomic_write_replaces_document_and_lock_file_survives() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("current.json");
    atomic_write(&path, b"old").unwrap();
    atomic_write(&path, b"new").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    {
        let _lock = InstallLock::acquire(temp.path()).unwrap();
    }
    assert!(temp.path().join(".install.lock").exists());
    let _again = InstallLock::acquire(temp.path()).unwrap();
}

#[test]
fn rejects_file_directory_conflicts_in_either_order() {
    for entries in [
        vec![("mods", b"x".as_slice()), ("mods/a.txt", b"y".as_slice())],
        vec![("mods/a.txt", b"y".as_slice()), ("mods", b"x".as_slice())],
    ] {
        let temp = tempfile::tempdir().unwrap();
        let zip = temp.path().join("archive.zip");
        fs::write(&zip, archive(&entries)).unwrap();
        let error = extract_verified_zip(
            &zip,
            &temp.path().join("content"),
            2,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsafeArchive);
    }
}

#[test]
fn incomplete_release_is_not_considered_installed() {
    let temp = tempfile::tempdir().unwrap();
    let server: super::super::config::Server = serde_json::from_value(serde_json::json!({
        "id": "survival", "name": "Survival", "description": "Test", "version": "1",
        "auth": { "login_url": "https://auth.example.com/login" },
        "distribution": { "url": "https://cdn.example.com/a.zip", "sha256": "a".repeat(64), "size_bytes": 10, "unpacked_size_bytes": 10 }
    })).unwrap();
    let receipt = InstallReceipt {
        server_id: "survival".into(),
        version: "1".into(),
        sha256: "a".repeat(64),
        installed_at: 1,
        already_installed: false,
    };
    atomic_write(
        &temp.path().join("current.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    assert!(installed_receipt(temp.path(), &server).is_none());
    let release = temp.path().join("releases").join("a".repeat(64));
    atomic_write(&release.join(".line-complete"), b"line-release-v1\n").unwrap();
    assert!(installed_receipt(temp.path(), &server).is_some());
}

#[test]
fn crash_staging_cleanup_preserves_published_release_and_pointer() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path();
    let staging = base.join(".staging-crashed");
    fs::create_dir_all(staging.join("content")).unwrap();
    fs::write(staging.join("archive.zip.part"), b"partial").unwrap();
    let release = base.join("releases").join("a".repeat(64));
    fs::create_dir_all(&release).unwrap();
    fs::write(release.join(".line-complete"), b"line-release-v1\n").unwrap();
    atomic_write(base.join("current.json"), b"old-pointer").unwrap();
    cleanup_staging(base).unwrap();
    assert!(!staging.exists());
    assert!(release.join(".line-complete").exists());
    assert_eq!(fs::read(base.join("current.json")).unwrap(), b"old-pointer");
}

#[test]
fn lock_is_recoverable_after_owner_drop_and_file_is_never_unlinked() {
    let temp = tempfile::tempdir().unwrap();
    {
        let _lock = InstallLock::acquire(temp.path()).unwrap();
        assert_eq!(
            InstallLock::acquire(temp.path()).unwrap_err().code,
            ErrorCode::Busy
        );
    }
    let _again = InstallLock::acquire(temp.path()).unwrap();
    assert!(temp.path().join(".install.lock").exists());
}
