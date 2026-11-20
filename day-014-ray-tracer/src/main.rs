use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use indicatif::ProgressBar;

use ray_tracer::camera::Camera;
use ray_tracer::render::{render_with_progress, row_progress_bar};
use ray_tracer::scene::Scene;

#[derive(Parser)]
#[command(name = "ray-tracer", version, about = "A from-scratch path tracer")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Render a TOML scene file to a PNG.
    Render(RenderArgs),
}

#[derive(clap::Args)]
struct RenderArgs {
    /// Scene file, e.g. scenes/showcase.toml.
    scene: PathBuf,
    /// Output PNG. Defaults to renders/<scene name>.png.
    #[arg(long, short)]
    out: Option<PathBuf>,
    /// Image width in pixels (height follows the camera's aspect ratio).
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    width: Option<u32>,
    /// Samples (rays) per pixel.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    spp: Option<u32>,
    /// Maximum bounces per ray.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    max_depth: Option<u32>,
    /// Random seed for sampling (and for a random_field without its own seed).
    #[arg(long)]
    seed: Option<u64>,
    /// Test every ray against every object instead of using the BVH.
    #[arg(long)]
    no_bvh: bool,
    /// No progress bar.
    #[arg(long, short)]
    quiet: bool,
}

fn default_out(scene: &Path) -> PathBuf {
    let stem = scene.file_stem().unwrap_or_default().to_string_lossy();
    Path::new("renders").join(format!("{stem}.png"))
}

fn render(args: RenderArgs) -> Result<(), String> {
    let mut scene = Scene::load(&args.scene).map_err(|e| e.to_string())?;
    if let Some(width) = args.width {
        scene.width = width;
    }
    if let Some(spp) = args.spp {
        scene.settings.samples_per_pixel = spp;
    }
    if let Some(depth) = args.max_depth {
        scene.settings.max_depth = depth;
    }
    if let Some(seed) = args.seed {
        scene.settings.seed = seed;
    }
    let out = args.out.unwrap_or_else(|| default_out(&args.scene));
    let use_bvh = !args.no_bvh;

    let start = Instant::now();
    let world = scene.world(use_bvh);
    let objects = scene.objects().len();
    let camera = Camera::new(&scene.camera, scene.width);
    let progress = if args.quiet {
        ProgressBar::hidden()
    } else {
        row_progress_bar(camera.image_height)
    };
    let image = render_with_progress(world.as_ref(), &camera, &scene.settings, &progress);
    progress.finish_and_clear();
    let elapsed = start.elapsed();

    image
        .save_png(&out)
        .map_err(|e| format!("could not write {}: {e}", out.display()))?;
    println!(
        "Rendered {}x{} at {} spp, max depth {} ({} objects, BVH {}, {} threads) in {:.2}s",
        image.width,
        image.height,
        scene.settings.samples_per_pixel,
        scene.settings.max_depth,
        objects,
        if use_bvh { "on" } else { "off" },
        rayon::current_num_threads(),
        elapsed.as_secs_f64()
    );
    println!("Wrote {}", out.display());
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Render(args) => render(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
