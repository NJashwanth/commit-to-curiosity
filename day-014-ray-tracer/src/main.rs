use std::path::PathBuf;
use std::process::ExitCode;

use ray_tracer::render::gradient;

fn main() -> ExitCode {
    let out = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "renders/gradient.png".into()),
    );
    match gradient(256, 256).save_png(&out) {
        Ok(()) => {
            println!("Wrote {}", out.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: could not write {}: {e}", out.display());
            ExitCode::FAILURE
        }
    }
}
