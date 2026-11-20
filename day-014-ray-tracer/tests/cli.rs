//! Runs the real binary.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ray-tracer"))
}

fn scene(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scenes")
        .join(name)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rt-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn render(args: &[&str], cwd: &Path) -> Output {
    bin()
        .arg("render")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap()
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn renders_the_showcase_to_the_default_path() {
    let dir = temp_dir("default");
    let showcase = scene("showcase.toml");
    let o = render(
        &[showcase.to_str().unwrap(), "--width", "32", "--spp", "2"],
        &dir,
    );
    assert!(o.status.success(), "{}", stderr(&o));
    let out = dir.join("renders/showcase.png");
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[..4], b"\x89PNG");
    // 32 wide at 16:9 is 18 tall. The PNG header stores both big-endian.
    assert_eq!(&bytes[16..24], &[0, 0, 0, 32, 0, 0, 0, 18]);
    let text = stdout(&o);
    assert!(
        text.contains("Rendered 32x18 at 2 spp, max depth 50 (20 objects, BVH on, "),
        "{text}"
    );
    assert!(text.contains("s\nWrote renders/showcase.png"), "{text}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn bvh_and_brute_force_render_the_same_bytes() {
    let dir = temp_dir("bvh");
    let random = scene("random.toml");
    let common = [
        random.to_str().unwrap(),
        "--width",
        "40",
        "--spp",
        "2",
        "--max-depth",
        "5",
        "-q",
    ];
    let with = render(&[&common[..], &["--out", "bvh.png"]].concat(), &dir);
    let without = render(
        &[&common[..], &["--out", "list.png", "--no-bvh"]].concat(),
        &dir,
    );
    assert!(with.status.success() && without.status.success());
    assert!(stdout(&with).contains("BVH on"));
    assert!(stdout(&without).contains("BVH off"));
    assert!(stdout(&with).contains("max depth 5"));
    assert_eq!(
        std::fs::read(dir.join("bvh.png")).unwrap(),
        std::fs::read(dir.join("list.png")).unwrap()
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn seed_changes_the_random_scene_and_is_reproducible() {
    let dir = temp_dir("seed");
    let random = scene("random.toml");
    let run = |seed: &str, out: &str| {
        let o = render(
            &[
                random.to_str().unwrap(),
                "--width",
                "24",
                "--spp",
                "1",
                "--seed",
                seed,
                "-o",
                out,
            ],
            &dir,
        );
        assert!(o.status.success(), "{}", stderr(&o));
        std::fs::read(dir.join(out)).unwrap()
    };
    let a = run("42", "a.png");
    assert_eq!(run("42", "b.png"), a);
    assert_ne!(run("7", "c.png"), a);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn bad_scene_files_give_clear_errors() {
    let dir = temp_dir("bad");
    std::fs::write(
        dir.join("typo.toml"),
        "[camera]\nlook_from = [0, 0, 1]\nlook_at = [0, 0, 0]\nvfov = 40\n\n\
         [materials.shiny]\ntype = \"chrome\"\n",
    )
    .unwrap();
    let o = render(&["typo.toml"], &dir);
    assert!(!o.status.success());
    let err = stderr(&o);
    assert!(err.starts_with("error: invalid scene file:"), "{err}");
    assert!(err.contains("unknown variant `chrome`"), "{err}");

    let o = render(&["missing.toml"], &dir);
    assert!(!o.status.success());
    assert!(stderr(&o).starts_with("error: could not read missing.toml"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn reports_unwritable_output() {
    let dir = temp_dir("unwritable");
    std::fs::write(dir.join("file"), b"x").unwrap();
    let showcase = scene("showcase.toml");
    let o = render(
        &[
            showcase.to_str().unwrap(),
            "--width",
            "8",
            "--spp",
            "1",
            "-q",
            "--out",
            "file/out.png",
        ],
        &dir,
    );
    assert!(!o.status.success());
    assert!(
        stderr(&o).contains("could not write file/out.png"),
        "{}",
        stderr(&o)
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn rejects_bad_arguments() {
    let o = bin()
        .args(["render", "x.toml", "--spp", "0"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(stderr(&o).contains("--spp"));
    let o = bin().arg("render").output().unwrap();
    assert!(!o.status.success());
    assert!(stderr(&o).contains("<SCENE>"));
}
