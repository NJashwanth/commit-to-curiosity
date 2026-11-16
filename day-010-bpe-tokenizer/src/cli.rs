//! The `bpe` command line: train, encode, decode, viz and stats.
//!
//! [`run`] takes its arguments and streams as parameters so the whole CLI
//! can be exercised from tests without spawning a process.

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::vocab::BASE_VOCAB_SIZE;
use crate::{Error, Pattern, Tokenizer, TrainOptions, Vocab, train};

#[derive(Parser, Debug)]
#[command(
    name = "bpe",
    version,
    about = "A byte-level BPE tokenizer: train, encode, decode and visualise"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Learn merges from a text file and save the vocab as JSON
    Train(TrainArgs),
    /// Turn text into token ids
    Encode(EncodeArgs),
    /// Turn token ids back into text
    Decode(DecodeArgs),
    /// Show how text splits into tokens, with colours and ids
    Viz(VizArgs),
    /// Measure compression, vocab usage and encode speed on a text file
    Stats(StatsArgs),
}

#[derive(Args, Debug)]
struct TrainArgs {
    /// Training text (UTF-8)
    #[arg(long)]
    input: PathBuf,
    /// Final vocab size, including the 256 byte tokens and special tokens
    #[arg(long, default_value_t = 1024)]
    vocab_size: usize,
    /// Where to write the vocab JSON
    #[arg(long)]
    out: PathBuf,
    /// Skip pre-tokenization, so merges can cross word boundaries
    #[arg(long)]
    no_split: bool,
    /// Pre-tokenization pattern
    #[arg(long, value_enum, default_value_t = PatternArg::Gpt4)]
    pattern: PatternArg,
    /// Special token to reserve; repeat for several
    #[arg(
        long = "special",
        value_name = "TOKEN",
        default_value = "<|endoftext|>"
    )]
    special: Vec<String>,
    /// Reserve no special tokens
    #[arg(long, conflicts_with = "special")]
    no_special: bool,
    /// Hide the progress bar
    #[arg(long, short)]
    quiet: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum PatternArg {
    Gpt2,
    Gpt4,
}

impl From<PatternArg> for Pattern {
    fn from(arg: PatternArg) -> Self {
        match arg {
            PatternArg::Gpt2 => Pattern::Gpt2,
            PatternArg::Gpt4 => Pattern::Gpt4,
        }
    }
}

/// Where the text comes from: arguments, a file, or stdin.
#[derive(Args, Debug)]
struct TextInput {
    /// Text to process; several arguments are joined with spaces
    text: Vec<String>,
    /// Read the text from a file instead
    #[arg(long, conflicts_with = "text")]
    file: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct EncodeArgs {
    /// Vocab JSON written by `train`
    #[arg(long)]
    vocab: PathBuf,
    #[command(flatten)]
    input: TextInput,
    /// Treat special token strings as plain text
    #[arg(long)]
    no_special: bool,
}

#[derive(Args, Debug)]
struct DecodeArgs {
    /// Vocab JSON written by `train`
    #[arg(long)]
    vocab: PathBuf,
    /// Token ids; read from stdin when none are given
    ids: Vec<u32>,
}

#[derive(Args, Debug)]
struct VizArgs {
    /// Vocab JSON written by `train`
    #[arg(long)]
    vocab: PathBuf,
    #[command(flatten)]
    input: TextInput,
    /// Mark token boundaries with brackets instead of colours
    #[arg(long)]
    no_color: bool,
}

#[derive(Args, Debug)]
struct StatsArgs {
    /// Vocab JSON written by `train`
    #[arg(long)]
    vocab: PathBuf,
    /// Text file to encode
    #[arg(long)]
    input: PathBuf,
    /// How many of the longest tokens to list
    #[arg(long, default_value_t = 20)]
    top: usize,
}

/// Why the CLI stopped.
#[derive(Debug)]
pub enum CliError {
    /// Bad arguments, or `--help` / `--version` (which exit successfully).
    Clap(clap::Error),
    Tokenizer(Error),
    Io(io::Error),
    Usage(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Clap(err) => write!(f, "{err}"),
            CliError::Tokenizer(err) => write!(f, "{err}"),
            CliError::Io(err) => write!(f, "{err}"),
            CliError::Usage(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<Error> for CliError {
    fn from(err: Error) -> Self {
        CliError::Tokenizer(err)
    }
}

impl From<io::Error> for CliError {
    fn from(err: io::Error) -> Self {
        CliError::Io(err)
    }
}

/// Parse `args` (including the program name) and run the command.
pub fn run<I, T>(
    args: I,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<(), CliError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = Cli::try_parse_from(args).map_err(CliError::Clap)?;
    match cli.command {
        Command::Train(args) => cmd_train(&args, out, err),
        Command::Encode(args) => cmd_encode(&args, stdin, out),
        Command::Decode(args) => cmd_decode(&args, stdin, out, err),
        Command::Viz(args) => cmd_viz(&args, stdin, out),
        Command::Stats(args) => cmd_stats(&args, out),
    }
}

fn read_text_file(path: &Path) -> Result<String, CliError> {
    let bytes = fs::read(path)
        .map_err(|e| CliError::Usage(format!("cannot read {}: {e}", path.display())))?;
    String::from_utf8(bytes)
        .map_err(|_| CliError::Usage(format!("{} is not valid UTF-8", path.display())))
}

fn load_tokenizer(path: &Path) -> Result<Tokenizer, CliError> {
    let vocab = Vocab::load(path)
        .map_err(|e| CliError::Usage(format!("cannot load vocab {}: {e}", path.display())))?;
    Ok(Tokenizer::new(vocab))
}

fn read_input(input: &TextInput, stdin: &mut dyn Read) -> Result<String, CliError> {
    if !input.text.is_empty() {
        return Ok(input.text.join(" "));
    }
    if let Some(path) = &input.file {
        return read_text_file(path);
    }
    let mut text = String::new();
    stdin
        .read_to_string(&mut text)
        .map_err(|e| CliError::Usage(format!("cannot read stdin: {e}")))?;
    Ok(text)
}

/// `1234567` -> `"1,234,567"`.
pub(crate) fn group_digits(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn describe(vocab: &Vocab) -> String {
    let specials = vocab.special_tokens().count();
    format!(
        "{} tokens = {BASE_VOCAB_SIZE} bytes + {} merges + {specials} special",
        vocab.len(),
        vocab.merges().len()
    )
}

fn cmd_train(args: &TrainArgs, out: &mut dyn Write, err: &mut dyn Write) -> Result<(), CliError> {
    let text = read_text_file(&args.input)?;
    let pattern = (!args.no_split).then(|| Pattern::from(args.pattern));
    let opts = TrainOptions {
        vocab_size: args.vocab_size,
        pattern,
        special_tokens: if args.no_special {
            Vec::new()
        } else {
            args.special.clone()
        },
        progress: !args.quiet,
    };
    let (vocab, report) = train(&text, &opts)?;
    vocab
        .save(&args.out)
        .map_err(|e| CliError::Usage(format!("cannot write {}: {e}", args.out.display())))?;

    let split = pattern.map_or("none (--no-split)", Pattern::name);
    writeln!(
        out,
        "read {} ({} bytes)",
        args.input.display(),
        group_digits(report.input_bytes)
    )?;
    writeln!(
        out,
        "learned {} merges from {} unique chunks in {:.2}s (pre-tokenization: {split})",
        group_digits(report.merges),
        group_digits(report.unique_chunks),
        report.elapsed.as_secs_f64()
    )?;
    writeln!(out, "vocab: {}", describe(&vocab))?;
    writeln!(out, "saved {}", args.out.display())?;
    if report.stopped_early() {
        writeln!(
            err,
            "warning: ran out of pairs to merge after {} of {} merges; the vocab has {} tokens instead of {}",
            report.merges,
            report.requested_merges,
            vocab.len(),
            args.vocab_size
        )?;
    }
    Ok(())
}

fn cmd_encode(
    args: &EncodeArgs,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let tok = load_tokenizer(&args.vocab)?;
    let text = read_input(&args.input, stdin)?;
    let ids = if args.no_special {
        tok.encode_ordinary(&text)
    } else {
        tok.encode(&text)
    };
    writeln!(out, "{}", join_ids(&ids))?;
    Ok(())
}

fn join_ids(ids: &[u32]) -> String {
    ids.iter().map(u32::to_string).collect::<Vec<_>>().join(" ")
}

fn cmd_decode(
    args: &DecodeArgs,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<(), CliError> {
    let tok = load_tokenizer(&args.vocab)?;
    let ids = if args.ids.is_empty() {
        let mut raw = String::new();
        stdin
            .read_to_string(&mut raw)
            .map_err(|e| CliError::Usage(format!("cannot read stdin: {e}")))?;
        raw.split_whitespace()
            .map(|s| {
                s.parse::<u32>()
                    .map_err(|_| CliError::Usage(format!("not a token id: {s:?}")))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        args.ids.clone()
    };
    let decoded = tok.decode(&ids)?;
    if decoded.lossy {
        writeln!(
            err,
            "warning: the tokens do not form valid UTF-8; invalid bytes were replaced with U+FFFD"
        )?;
    }
    writeln!(out, "{}", decoded.text)?;
    Ok(())
}

/// Pastel xterm-256 background colours, cycled per token.
const COLORS: [u8; 6] = [153, 186, 151, 217, 183, 223];

fn paint(text: &str, index: usize) -> String {
    let bg = COLORS[index % COLORS.len()];
    format!("\x1b[30;48;5;{bg}m{text}\x1b[0m")
}

/// How one token looks in `viz`: whitespace made visible, and bytes that are
/// only part of a character shown as `\xNN`. Returns whether it was partial.
fn viz_piece(bytes: &[u8]) -> (String, bool) {
    let mut out = String::new();
    let mut partial = false;
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\n' => out.push('↵'),
                '\t' => out.push('→'),
                '\r' => out.push('␍'),
                c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
                c => out.push(c),
            }
        }
        for b in chunk.invalid() {
            partial = true;
            out.push_str(&format!("\\x{b:02X}"));
        }
    }
    (out, partial)
}

/// Render `text` token by token, then the ids, then a one-line summary.
pub(crate) fn render_viz(tok: &Tokenizer, text: &str, color: bool) -> String {
    let ids = tok.encode(text);
    let mut pieces = String::new();
    let mut id_line = Vec::new();
    let mut any_partial = false;
    for (i, &id) in ids.iter().enumerate() {
        let bytes = tok
            .vocab()
            .token_bytes(id)
            .expect("encoded ids are in the vocab");
        let (shown, partial) = viz_piece(bytes);
        any_partial |= partial;
        if color {
            pieces.push_str(&paint(&shown, i));
            id_line.push(paint(&id.to_string(), i));
        } else {
            pieces.push_str(&format!("[{shown}]"));
            id_line.push(id.to_string());
        }
    }
    let mut out = format!("{pieces}\n\n{}\n\n", id_line.join(" "));
    let ratio = if ids.is_empty() {
        0.0
    } else {
        text.len() as f64 / ids.len() as f64
    };
    out.push_str(&format!(
        "{} bytes -> {} tokens ({ratio:.2} bytes/token)\n",
        text.len(),
        ids.len()
    ));
    if any_partial {
        out.push_str("\\xNN = one byte of a character that is split across tokens\n");
    }
    out
}

fn cmd_viz(args: &VizArgs, stdin: &mut dyn Read, out: &mut dyn Write) -> Result<(), CliError> {
    let tok = load_tokenizer(&args.vocab)?;
    let text = read_input(&args.input, stdin)?;
    write!(out, "{}", render_viz(&tok, &text, !args.no_color))?;
    Ok(())
}

/// How often encoding is timed; the fastest run is reported.
const TIMING_RUNS: usize = 3;

/// The numbers `stats` reports.
#[derive(Debug)]
pub(crate) struct Stats {
    pub bytes: usize,
    pub tokens: usize,
    /// Distinct token ids that appear in the encoding.
    pub used: usize,
    pub vocab_size: usize,
    /// Fastest of the timed encodes.
    pub encode_time: Duration,
    pub round_trip: bool,
    /// `(id, byte length, occurrences in the text)`, longest first.
    pub longest: Vec<(u32, usize, usize)>,
}

impl Stats {
    pub fn bytes_per_token(&self) -> f64 {
        if self.tokens == 0 {
            0.0
        } else {
            self.bytes as f64 / self.tokens as f64
        }
    }

    pub fn megabytes_per_second(&self) -> f64 {
        let secs = self.encode_time.as_secs_f64().max(1e-9);
        self.bytes as f64 / 1e6 / secs
    }
}

pub(crate) fn compute_stats(tok: &Tokenizer, text: &str, top: usize) -> Stats {
    let mut ids = Vec::new();
    let mut encode_time = Duration::MAX;
    for _ in 0..TIMING_RUNS {
        let start = Instant::now();
        ids = tok.encode(text);
        encode_time = encode_time.min(start.elapsed());
    }
    let vocab = tok.vocab();
    let mut counts = vec![0usize; vocab.len()];
    for &id in &ids {
        counts[id as usize] += 1;
    }
    let round_trip = tok.decode(&ids).is_ok_and(|d| d.text == text);

    let mut by_length: Vec<(u32, usize)> = (0..vocab.len() as u32)
        .filter(|&id| !vocab.is_special(id))
        .map(|id| (id, vocab.token_bytes(id).expect("id in range").len()))
        .collect();
    by_length.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let longest = by_length
        .into_iter()
        .take(top)
        .map(|(id, len)| (id, len, counts[id as usize]))
        .collect();

    Stats {
        bytes: text.len(),
        tokens: ids.len(),
        used: counts.iter().filter(|&&c| c > 0).count(),
        vocab_size: vocab.len(),
        encode_time,
        round_trip,
        longest,
    }
}

pub(crate) fn render_stats(tok: &Tokenizer, stats: &Stats) -> String {
    let vocab = tok.vocab();
    let pattern = vocab.pattern().map_or("none", Pattern::name);
    let mut out = String::new();
    let mut row = |label: &str, value: String| out.push_str(&format!("{label:<15}{value}\n"));
    row(
        "vocab",
        format!("{} (pre-tokenization: {pattern})", describe(vocab)),
    );
    row("bytes", group_digits(stats.bytes));
    row("tokens", group_digits(stats.tokens));
    row("bytes/token", format!("{:.2}", stats.bytes_per_token()));
    row(
        "vocab used",
        format!(
            "{} of {} tokens ({:.1}%)",
            group_digits(stats.used),
            group_digits(stats.vocab_size),
            100.0 * stats.used as f64 / stats.vocab_size as f64
        ),
    );
    row(
        "encode speed",
        format!(
            "{:.1} MB/s ({:.1} ms, best of {TIMING_RUNS})",
            stats.megabytes_per_second(),
            stats.encode_time.as_secs_f64() * 1e3
        ),
    );
    row(
        "round trip",
        if stats.round_trip { "ok" } else { "FAILED" }.to_owned(),
    );
    if !stats.longest.is_empty() {
        out.push_str(&format!("\n{} longest tokens:\n", stats.longest.len()));
        out.push_str(&format!(
            "{:>6} {:>6} {:>8}  token\n",
            "id", "bytes", "count"
        ));
        for &(id, len, count) in &stats.longest {
            let token = vocab.display_token(id).expect("id in range");
            // `display_token` already escapes newlines etc.; just quote it so
            // leading and trailing spaces are visible.
            out.push_str(&format!(
                "{id:>6} {len:>6} {:>8}  \"{token}\"\n",
                group_digits(count)
            ));
        }
    }
    out
}

fn cmd_stats(args: &StatsArgs, out: &mut dyn Write) -> Result<(), CliError> {
    let tok = load_tokenizer(&args.vocab)?;
    let text = read_text_file(&args.input)?;
    let stats = compute_stats(&tok, &text, args.top);
    writeln!(out, "{:<15}{}", "input", args.input.display())?;
    write!(out, "{}", render_stats(&tok, &stats))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const CORPUS: &str = "First Citizen: Before we proceed any further, hear me speak.\n\
        All: Speak, speak.\n\
        First Citizen: You are all resolved rather to die than to famish?\n\
        All: Resolved. resolved.\n\
        To be, or not to be, that is the question.\n";

    struct Run {
        result: Result<(), CliError>,
        out: String,
        err: String,
    }

    fn run_with(args: &[&str], stdin: &str) -> Run {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let argv = std::iter::once("bpe").chain(args.iter().copied());
        let result = run(argv, &mut stdin.as_bytes(), &mut out, &mut err);
        Run {
            result,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn ok(args: &[&str]) -> String {
        let r = run_with(args, "");
        assert!(r.result.is_ok(), "{args:?}: {:?}", r.result);
        r.out
    }

    fn fail(args: &[&str], stdin: &str) -> String {
        run_with(args, stdin).result.unwrap_err().to_string()
    }

    /// A temp dir with the corpus at `input.txt` and a vocab trained on it.
    fn setup(extra: &[&str]) -> (TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        fs::write(&input, CORPUS.repeat(5)).unwrap();
        let vocab = dir.path().join("vocab.json");
        let mut args = vec![
            "train",
            "--input",
            input.to_str().unwrap(),
            "--vocab-size",
            "300",
            "--out",
            vocab.to_str().unwrap(),
            "--quiet",
        ];
        args.extend_from_slice(extra);
        ok(&args);
        (dir, vocab.to_str().unwrap().to_owned())
    }

    fn ids_of(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn train_prints_a_summary_and_writes_the_vocab() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.txt");
        fs::write(&input, CORPUS.repeat(5)).unwrap();
        let out_path = dir.path().join("v.json");
        let args = [
            "train",
            "--input",
            input.to_str().unwrap(),
            "--vocab-size",
            "300",
            "--out",
            out_path.to_str().unwrap(),
            "--quiet",
        ];
        let out = ok(&args);
        assert!(out.contains("bytes)\nlearned 43 merges from "), "{out}");
        assert!(out.contains("(pre-tokenization: gpt4)"));
        assert!(out.contains("vocab: 300 tokens = 256 bytes + 43 merges + 1 special"));
        let vocab = Vocab::load(&out_path).unwrap();
        assert_eq!(vocab.special_id("<|endoftext|>"), Some(299));
        assert_eq!(vocab.pattern(), Some(Pattern::Gpt4));
    }

    #[test]
    fn train_options_change_the_vocab() {
        let (_d, v) = setup(&["--no-split"]);
        assert_eq!(Vocab::load(&v).unwrap().pattern(), None);
        let (_d, v) = setup(&["--pattern", "gpt2", "--no-special"]);
        let vocab = Vocab::load(&v).unwrap();
        assert_eq!(vocab.pattern(), Some(Pattern::Gpt2));
        assert_eq!(vocab.special_tokens().count(), 0);
        let (_d, v) = setup(&["--special", "<|a|>", "--special", "<|b|>"]);
        let vocab = Vocab::load(&v).unwrap();
        assert_eq!(vocab.special_id("<|a|>"), Some(298));
        assert_eq!(vocab.special_id("<|b|>"), Some(299));
        assert_eq!(vocab.special_id("<|endoftext|>"), None);
    }

    #[test]
    fn train_warns_when_it_runs_out_of_pairs() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("tiny.txt");
        fs::write(&input, "ab ab").unwrap();
        let out_path = dir.path().join("v.json");
        let r = run_with(
            &[
                "train",
                "--input",
                input.to_str().unwrap(),
                "--vocab-size",
                "300",
                "--out",
                out_path.to_str().unwrap(),
            ],
            "",
        );
        assert!(r.result.is_ok());
        assert!(
            r.err.contains("ran out of pairs to merge after 2 of 43 merges; the vocab has 259 tokens instead of 300"),
            "{}",
            r.err
        );
    }

    #[test]
    fn train_reports_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let out_path = dir.path().join("v.json");
        let out = out_path.to_str().unwrap();
        let missing = dir.path().join("missing.txt");
        let msg = fail(
            &["train", "--input", missing.to_str().unwrap(), "--out", out],
            "",
        );
        assert!(msg.starts_with("cannot read "), "{msg}");

        let binary = dir.path().join("bin.txt");
        fs::write(&binary, [0xFF, 0xFE, 0x00]).unwrap();
        let msg = fail(
            &["train", "--input", binary.to_str().unwrap(), "--out", out],
            "",
        );
        assert!(msg.ends_with("is not valid UTF-8"), "{msg}");

        let input = dir.path().join("in.txt");
        fs::write(&input, "hello").unwrap();
        let input = input.to_str().unwrap();
        let msg = fail(
            &[
                "train",
                "--input",
                input,
                "--out",
                out,
                "--vocab-size",
                "100",
            ],
            "",
        );
        assert_eq!(msg, "vocab size 100 is too small: it must be at least 257");

        let bad_out = dir.path().join("no/dir/v.json");
        let msg = fail(
            &[
                "train",
                "--input",
                input,
                "--out",
                bad_out.to_str().unwrap(),
            ],
            "",
        );
        assert!(msg.starts_with("cannot write "), "{msg}");
    }

    #[test]
    fn encode_then_decode_round_trips() {
        let (_d, v) = setup(&[]);
        for text in ["To be, or not to be", "Hello 👋 నమస్తే world", " "] {
            let ids = ok(&["encode", "--vocab", &v, text]);
            let mut args = vec!["decode", "--vocab", &v];
            let ids = ids_of(&ids);
            args.extend(ids.iter().map(String::as_str));
            assert_eq!(ok(&args), format!("{text}\n"));
        }
    }

    #[test]
    fn encode_reads_args_files_and_stdin() {
        let (dir, v) = setup(&[]);
        let joined = ok(&["encode", "--vocab", &v, "To", "be"]);
        assert_eq!(joined, ok(&["encode", "--vocab", &v, "To be"]));

        let file = dir.path().join("t.txt");
        fs::write(&file, "To be").unwrap();
        assert_eq!(
            ok(&["encode", "--vocab", &v, "--file", file.to_str().unwrap()]),
            joined
        );

        let r = run_with(&["encode", "--vocab", &v], "To be");
        assert_eq!(r.out, joined);
        assert_eq!(ok(&["encode", "--vocab", &v, ""]), "\n");
    }

    #[test]
    fn encode_keeps_special_tokens_unless_told_not_to() {
        let (_d, v) = setup(&[]);
        let with = ok(&["encode", "--vocab", &v, "speak<|endoftext|>"]);
        assert!(ids_of(&with).contains(&"299".to_string()), "{with}");
        let without = ok(&[
            "encode",
            "--vocab",
            &v,
            "--no-special",
            "speak<|endoftext|>",
        ]);
        assert!(!ids_of(&without).contains(&"299".to_string()));
        assert!(ids_of(&without).len() > ids_of(&with).len());
    }

    #[test]
    fn decode_reads_stdin_and_reports_bad_ids() {
        let (_d, v) = setup(&[]);
        let ids = ok(&["encode", "--vocab", &v, "To be, or not to be"]);
        let r = run_with(&["decode", "--vocab", &v], &ids);
        assert_eq!(r.out, "To be, or not to be\n");

        assert_eq!(
            fail(&["decode", "--vocab", &v, "72", "300"], ""),
            "token id 300 is not in the vocabulary (valid ids are 0..300)"
        );
        assert_eq!(
            fail(&["decode", "--vocab", &v], "72 x9"),
            "not a token id: \"x9\""
        );
        let err = run_with(&["decode", "--vocab", &v, "-5"], "")
            .result
            .unwrap_err();
        assert!(matches!(err, CliError::Clap(_)));
    }

    #[test]
    fn decode_warns_on_invalid_utf8() {
        let (_d, v) = setup(&[]);
        // 240 and 159 are the first two bytes of 👋.
        let r = run_with(&["decode", "--vocab", &v, "104", "240", "159"], "");
        assert!(r.result.is_ok());
        assert_eq!(r.out, "h\u{FFFD}\n");
        assert!(r.err.contains("do not form valid UTF-8"), "{}", r.err);
    }

    #[test]
    fn viz_colours_each_token_and_lists_ids() {
        let (_d, v) = setup(&[]);
        let out = ok(&["viz", "--vocab", &v, "To be, or not to be"]);
        assert!(out.contains("\x1b[30;48;5;153m"));
        assert!(out.contains("\x1b[0m"));
        assert!(out.contains("19 bytes -> "), "{out}");
        assert!(!out.contains("\\xNN"));
    }

    #[test]
    fn viz_plain_mode_brackets_tokens() {
        let (_d, v) = setup(&[]);
        let out = ok(&["viz", "--vocab", &v, "--no-color", "speak, speak"]);
        let first = out.lines().next().unwrap();
        assert!(first.starts_with('[') && first.ends_with(']'), "{first}");
        assert_eq!(
            first.replace("][", "").trim_matches(['[', ']']),
            "speak, speak"
        );
        assert!(out.contains("12 bytes -> "));
    }

    #[test]
    fn viz_shows_split_characters_and_whitespace() {
        let tok = Tokenizer::new(Vocab::byte_level());
        let out = render_viz(&tok, "a\n\t👋\r\u{7}", false);
        assert!(
            out.starts_with("[a][↵][→][\\xF0][\\x9F][\\x91][\\x8B][␍][\\u{7}]"),
            "{out}"
        );
        assert!(out.contains("9 bytes -> 9 tokens (1.00 bytes/token)"));
        assert!(out.contains("\\xNN = one byte of a character"));
        assert!(render_viz(&tok, "", true).contains("0 bytes -> 0 tokens (0.00 bytes/token)"));
    }

    #[test]
    fn viz_reads_a_file() {
        let (dir, v) = setup(&[]);
        let file = dir.path().join("t.txt");
        fs::write(&file, "speak").unwrap();
        let out = ok(&[
            "viz",
            "--vocab",
            &v,
            "--no-color",
            "--file",
            file.to_str().unwrap(),
        ]);
        assert!(out.starts_with('['));
        let missing = dir.path().join("nope.txt");
        let msg = fail(
            &["viz", "--vocab", &v, "--file", missing.to_str().unwrap()],
            "",
        );
        assert!(msg.starts_with("cannot read "));
    }

    #[test]
    fn missing_or_broken_vocab_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none.json");
        let msg = fail(&["encode", "--vocab", missing.to_str().unwrap(), "x"], "");
        assert!(msg.starts_with("cannot load vocab "), "{msg}");
        let broken = dir.path().join("broken.json");
        fs::write(&broken, "{}").unwrap();
        let msg = fail(&["decode", "--vocab", broken.to_str().unwrap(), "1"], "");
        assert!(msg.contains("not valid JSON"), "{msg}");
    }

    #[test]
    fn help_and_bad_arguments_come_from_clap() {
        let err = run_with(&["--help"], "").result.unwrap_err();
        let CliError::Clap(e) = &err else {
            panic!("expected a clap error")
        };
        assert_eq!(e.kind(), clap::error::ErrorKind::DisplayHelp);
        assert!(err.to_string().contains("train"));
        let err = run_with(&["frobnicate"], "").result.unwrap_err();
        assert!(matches!(err, CliError::Clap(_)));
        let msg = fail(&["encode", "--vocab", "v.json", "--file", "f", "text"], "");
        assert!(msg.contains("cannot be used with"), "{msg}");
    }

    #[test]
    fn failing_streams_surface_as_errors() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("stdin closed"))
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::other("stdout closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (_d, v) = setup(&[]);
        let mut sink = Vec::new();
        let args = ["bpe", "encode", "--vocab", &v];
        let err = run(args, &mut Broken, &mut sink, &mut Vec::new()).unwrap_err();
        assert_eq!(err.to_string(), "cannot read stdin: stdin closed");
        let args = ["bpe", "decode", "--vocab", &v];
        let err = run(args, &mut Broken, &mut sink, &mut Vec::new()).unwrap_err();
        assert_eq!(err.to_string(), "cannot read stdin: stdin closed");
        let args = ["bpe", "encode", "--vocab", &v, "x"];
        let err = run(args, &mut io::empty(), &mut Broken, &mut Vec::new()).unwrap_err();
        assert!(matches!(err, CliError::Io(_)));
        assert_eq!(err.to_string(), "stdout closed");
    }

    #[test]
    fn stats_reports_compression_usage_and_longest_tokens() {
        let (dir, v) = setup(&[]);
        let input = dir.path().join("input.txt");
        let out = ok(&[
            "stats",
            "--vocab",
            &v,
            "--input",
            input.to_str().unwrap(),
            "--top",
            "5",
        ]);
        assert!(out.starts_with("input          "), "{out}");
        assert!(out.contains(
            "vocab          300 tokens = 256 bytes + 43 merges + 1 special (pre-tokenization: gpt4)"
        ));
        assert!(out.contains(&format!(
            "bytes          {}\n",
            group_digits(CORPUS.len() * 5)
        )));
        assert!(out.contains("round trip     ok"));
        assert!(out.contains(" MB/s ("));
        assert!(out.contains("5 longest tokens:\n    id  bytes    count  token\n"));
        // Escapes are shown once, not JSON-escaped a second time.
        assert!(!out.contains("\\\\"), "{out}");
        // The special token is excluded from the longest-token list.
        assert!(!out.contains("<|endoftext|>"));
    }

    #[test]
    fn stats_numbers_are_consistent() {
        let tok = Tokenizer::new(Vocab::byte_level());
        let stats = compute_stats(&tok, "abca", 3);
        assert_eq!((stats.bytes, stats.tokens, stats.used), (4, 4, 3));
        assert_eq!(stats.vocab_size, 256);
        assert!((stats.bytes_per_token() - 1.0).abs() < 1e-9);
        assert!(stats.megabytes_per_second() > 0.0);
        assert!(stats.round_trip);
        // All base tokens are one byte long; ties go to the lowest id.
        assert_eq!(stats.longest, vec![(0, 1, 0), (1, 1, 0), (2, 1, 0)]);

        // Token 10 is "\n": shown escaped once, inside quotes.
        let listing = render_stats(&tok, &compute_stats(&tok, "a\n", 11));
        assert!(
            listing.contains("    10      1        1  \"\\n\"\n"),
            "{listing}"
        );

        let empty = compute_stats(&tok, "", 0);
        assert_eq!(empty.bytes_per_token(), 0.0);
        assert!(empty.longest.is_empty());
        let text = render_stats(&tok, &empty);
        assert!(text.contains("vocab used     0 of 256 tokens (0.0%)"));
        assert!(!text.contains("longest"));
    }

    #[test]
    fn stats_flags_a_failed_round_trip() {
        let tok = Tokenizer::new(Vocab::byte_level());
        let mut stats = compute_stats(&tok, "x", 1);
        stats.round_trip = false;
        assert!(render_stats(&tok, &stats).contains("round trip     FAILED"));
    }

    #[test]
    fn stats_needs_readable_files() {
        let (dir, v) = setup(&[]);
        let missing = dir.path().join("missing.txt");
        let msg = fail(
            &["stats", "--vocab", &v, "--input", missing.to_str().unwrap()],
            "",
        );
        assert!(msg.starts_with("cannot read "));
    }

    #[test]
    fn digits_are_grouped() {
        assert_eq!(group_digits(0), "0");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1000), "1,000");
        assert_eq!(group_digits(1115394), "1,115,394");
    }
}
