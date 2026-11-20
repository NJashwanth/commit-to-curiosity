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
    let out = dir.join("demo.png");
    let status = bin()
        .arg(&out)
        .args(["--width", "32", "--spp", "2"])
        .status()
        .unwrap();
    assert!(status.success());
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[..4], b"\x89PNG");
    // Width 32 at 16:9 is 18 rows. The PNG header stores width and height big-endian.
    assert_eq!(&bytes[16..24], &[0, 0, 0, 32, 0, 0, 0, 18]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn bvh_and_brute_force_render_the_same_bytes() {
    let dir = temp_dir("bvh");
    let with = dir.join("bvh.png");
    let without = dir.join("list.png");
    for (out, extra) in [(&with, None), (&without, Some("--no-bvh"))] {
        let status = bin()
            .arg(out)
            .args(["--width", "40", "--spp", "3"])
            .args(extra)
            .status()
            .unwrap();
        assert!(status.success());
    }
    assert_eq!(
        std::fs::read(&with).unwrap(),
        std::fs::read(&without).unwrap()
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn rejects_bad_numbers() {
    let output = bin().args(["--spp", "zero"]).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--spp needs a positive number"));
}

#[test]
fn reports_unwritable_output() {
    let dir = temp_dir("bad");
    let blocker = dir.join("file");
    std::fs::write(&blocker, b"x").unwrap();
    let output = bin()
        .arg(blocker.join("out.png"))
        .args(["--width", "8", "--spp", "1"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not write"));
    std::fs::remove_dir_all(&dir).unwrap();
}
