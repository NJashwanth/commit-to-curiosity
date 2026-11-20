use std::path::PathBuf;
use std::process::ExitCode;

use ray_tracer::camera::Camera;
use ray_tracer::hittable::HittableList;
use ray_tracer::render::{RenderSettings, render};
use ray_tracer::sphere::Sphere;
use ray_tracer::vec3::Vec3;

struct Args {
    out: PathBuf,
    width: u32,
    spp: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        out: PathBuf::from("renders/demo.png"),
        width: 400,
        spp: 100,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut number = |name: &str| -> Result<u32, String> {
            it.next()
                .and_then(|v| v.parse().ok())
                .filter(|&n| n > 0)
                .ok_or(format!("{name} needs a positive number"))
        };
        match arg.as_str() {
            "--width" => args.width = number("--width")?,
            "--spp" => args.spp = number("--spp")?,
            _ => args.out = PathBuf::from(arg),
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut world = HittableList::new();
    world.add(Sphere::new(Vec3::new(0.0, 0.0, -1.0), 0.5));
    world.add(Sphere::new(Vec3::new(0.0, -100.5, -1.0), 100.0));

    let height = (args.width as f64 * 9.0 / 16.0).round().max(1.0) as u32;
    let camera = Camera::new(args.width, height);
    let settings = RenderSettings {
        samples_per_pixel: args.spp,
        ..RenderSettings::default()
    };
    match render(&world, &camera, &settings).save_png(&args.out) {
        Ok(()) => {
            println!("Wrote {}", args.out.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: could not write {}: {e}", args.out.display());
            ExitCode::FAILURE
        }
    }
}
