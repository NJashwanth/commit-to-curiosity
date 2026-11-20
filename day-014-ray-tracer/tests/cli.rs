//! Runs the real binary.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ray-tracer"))
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rt-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn writes_a_png() {
    let dir = temp_dir("png");
    let out = dir.join("sphere.png");
    let status = bin().arg(&out).status().unwrap();
    assert!(status.success());
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[..4], b"\x89PNG");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn reports_unwritable_output() {
    let dir = temp_dir("bad");
    let blocker = dir.join("file");
    std::fs::write(&blocker, b"x").unwrap();
    let output = bin().arg(blocker.join("out.png")).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not write"));
    std::fs::remove_dir_all(&dir).unwrap();
}
