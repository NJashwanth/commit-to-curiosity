use std::io::{self, BufWriter, Write};
use std::process::ExitCode;

use bpe_tokenizer::cli::{self, CliError};

fn main() -> ExitCode {
    let mut stdin = io::stdin().lock();
    let mut out = BufWriter::new(io::stdout().lock());
    let mut err = io::stderr();
    let result = cli::run(std::env::args_os(), &mut stdin, &mut out, &mut err);
    let flushed = out.flush();
    match result.and(flushed.map_err(CliError::Io)) {
        Ok(()) => ExitCode::SUCCESS,
        // --help and --version also arrive here; clap picks the exit code.
        Err(CliError::Clap(e)) => e.exit(),
        Err(e) => {
            let _ = writeln!(err, "error: {e}");
            ExitCode::FAILURE
        }
    }
}
