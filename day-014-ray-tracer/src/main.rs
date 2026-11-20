use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use ray_tracer::bvh::Bvh;
use ray_tracer::camera::{Camera, CameraConfig};
use ray_tracer::hittable::{Hittable, HittableList};
use ray_tracer::material::Material;
use ray_tracer::render::{RenderSettings, render_with_progress, row_progress_bar};
use ray_tracer::sphere::Sphere;
use ray_tracer::vec3::{Color, Vec3};

struct Args {
    out: PathBuf,
    width: u32,
    spp: u32,
    bvh: bool,
    quiet: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        out: PathBuf::from("renders/demo.png"),
        width: 400,
        spp: 100,
        bvh: true,
        quiet: false,
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
            "--no-bvh" => args.bvh = false,
            "--quiet" => args.quiet = true,
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

    let ground = Material::lambertian(Color::new(0.8, 0.8, 0.0));
    let matte_blue = Material::lambertian(Color::new(0.1, 0.2, 0.5));
    let glass = Material::dielectric(1.5);
    // Inside the glass, a sphere of air: a hollow glass ball.
    let air_bubble = Material::dielectric(1.0 / 1.5);
    let gold = Material::metal(Color::new(0.8, 0.6, 0.2), 0.2);

    let mut world = HittableList::new();
    world.add(Sphere::new(Vec3::new(0.0, -100.5, -1.0), 100.0, ground));
    world.add(Sphere::new(Vec3::new(0.0, 0.0, -1.2), 0.5, matte_blue));
    world.add(Sphere::new(Vec3::new(-1.0, 0.0, -1.0), 0.5, glass));
    world.add(Sphere::new(Vec3::new(-1.0, 0.0, -1.0), 0.4, air_bubble));
    world.add(Sphere::new(Vec3::new(1.0, 0.0, -1.0), 0.5, gold));

    // Up and to the left, zoomed in, focused on the blue sphere.
    let look_from = Vec3::new(-3.0, 2.0, 2.0);
    let look_at = Vec3::new(0.0, 0.0, -1.0);
    let config = CameraConfig {
        look_from,
        look_at,
        vfov: 25.0,
        aperture: 0.6,
        focus_dist: (look_from - Vec3::new(0.0, 0.0, -1.2)).length(),
        ..CameraConfig::default()
    };
    let camera = Camera::new(&config, args.width);
    let settings = RenderSettings {
        samples_per_pixel: args.spp,
        ..RenderSettings::default()
    };
    let objects = world.len();
    let start = Instant::now();
    let world: Box<dyn Hittable> = if args.bvh {
        Box::new(Bvh::new(world.objects))
    } else {
        Box::new(world)
    };
    let progress = if args.quiet {
        indicatif::ProgressBar::hidden()
    } else {
        row_progress_bar(camera.image_height)
    };
    let image = render_with_progress(world.as_ref(), &camera, &settings, &progress);
    progress.finish_and_clear();
    let elapsed = start.elapsed();

    match image.save_png(&args.out) {
        Ok(()) => {
            println!(
                "Rendered {}x{} at {} spp ({} objects, BVH {}, {} threads) in {:.2}s",
                image.width,
                image.height,
                settings.samples_per_pixel,
                objects,
                if args.bvh { "on" } else { "off" },
                rayon::current_num_threads(),
                elapsed.as_secs_f64()
            );
            println!("Wrote {}", args.out.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: could not write {}: {e}", args.out.display());
            ExitCode::FAILURE
        }
    }
}
