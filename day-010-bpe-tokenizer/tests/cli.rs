//! End-to-end tests that run the real `bpe` binary.

use std::fs;
use std::process::{Command, Output};

fn bpe(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bpe"))
        .args(args)
        .output()
        .expect("binary runs")
}

fn stdout(o: &Output) -> String {
    String::from_utf8(o.stdout.clone()).unwrap()
}

fn stderr(o: &Output) -> String {
    String::from_utf8(o.stderr.clone()).unwrap()
}

#[test]
fn train_encode_decode_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.txt");
    let text = "To be, or not to be, that is the question:\n\
                Whether 'tis nobler in the mind to suffer\n"
        .repeat(20);
    fs::write(&input, text).unwrap();
    let vocab = dir.path().join("vocab.json");
    let vocab = vocab.to_str().unwrap();

    let train = bpe(&[
        "train",
        "--input",
        input.to_str().unwrap(),
        "--vocab-size",
        "320",
        "--out",
        vocab,
        "--quiet",
    ]);
    assert!(train.status.success(), "{}", stderr(&train));
    assert!(stdout(&train).contains("saved "));

    let encode = bpe(&["encode", "--vocab", vocab, "To be, or not to be"]);
    assert!(encode.status.success());
    let ids = stdout(&encode);
    let mut args = vec!["decode", "--vocab", vocab];
    args.extend(ids.split_whitespace());
    let decode = bpe(&args);
    assert_eq!(stdout(&decode), "To be, or not to be\n");
}

#[test]
fn errors_exit_with_status_one() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.json");
    let out = bpe(&["decode", "--vocab", missing.to_str().unwrap(), "1"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).starts_with("error: cannot load vocab "),
        "{}",
        stderr(&out)
    );
}

#[test]
fn help_succeeds_and_bad_usage_fails() {
    let help = bpe(&["--help"]);
    assert!(help.status.success());
    for cmd in ["train", "encode", "decode", "viz"] {
        assert!(stdout(&help).contains(cmd), "help lists {cmd}");
    }
    let bad = bpe(&["encode"]);
    assert_eq!(bad.status.code(), Some(2));
    assert!(stderr(&bad).contains("--vocab"));
}
