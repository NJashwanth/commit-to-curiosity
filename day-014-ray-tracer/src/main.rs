use std::path::PathBuf;
use std::process::ExitCode;

use ray_tracer::camera::Camera;
use ray_tracer::render::render_normals;
use ray_tracer::sphere::Sphere;
use ray_tracer::vec3::Vec3;

fn main() -> ExitCode {
    let out = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "renders/sphere.png".into()),
    );
    let sphere = Sphere::new(Vec3::new(0.0, 0.0, -1.0), 0.5);
    let camera = Camera::new(400, 225);
    match render_normals(&sphere, &camera).save_png(&out) {
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
