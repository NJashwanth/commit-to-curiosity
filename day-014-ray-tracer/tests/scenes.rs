//! The bundled scene files load and render deterministically.

use std::path::Path;

use ray_tracer::camera::Camera;
use ray_tracer::material::Material;
use ray_tracer::render::{RenderSettings, render};
use ray_tracer::scene::Scene;

fn load(name: &str) -> Scene {
    Scene::load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("scenes")
            .join(name),
    )
    .unwrap()
}

#[test]
fn showcase_loads_with_all_three_material_kinds() {
    let scene = load("showcase.toml");
    assert!(scene.random_field.is_none());
    let objects = scene.objects();
    assert_eq!(objects.len(), 20);
    let count = |f: fn(&Material) -> bool| objects.iter().filter(|s| f(&s.material)).count();
    assert!(count(|m| matches!(m, Material::Lambertian { .. })) >= 5);
    assert!(count(|m| matches!(m, Material::Metal { .. })) >= 5);
    assert!(count(|m| matches!(m, Material::Dielectric { .. })) >= 3);
}

#[test]
fn random_loads_the_classic_field() {
    let scene = load("random.toml");
    assert_eq!(scene.spheres.len(), 4);
    let field = scene.random_field.unwrap();
    assert_eq!((field.extent, field.radius, field.seed), (11, 0.2, None));
    // 484 grid cells, a few skipped where they'd hit the three big spheres.
    let n = scene.objects().len() - 4;
    assert!(n > 460 && n < 484, "{n}");
}

#[test]
fn same_seed_renders_byte_identical_images() {
    for name in ["showcase.toml", "random.toml"] {
        let scene = load(name);
        let camera = Camera::new(&scene.camera, 32);
        assert_eq!(camera.image_height, 18);
        let settings = RenderSettings {
            samples_per_pixel: 4,
            max_depth: 10,
            seed: 2024,
        };
        let world = scene.world(true);
        let a = render(world.as_ref(), &camera, &settings).png_bytes();
        let b = render(world.as_ref(), &camera, &settings).png_bytes();
        assert_eq!(a, b, "{name}");
        let other = RenderSettings {
            seed: 2025,
            ..settings
        };
        assert_ne!(
            render(world.as_ref(), &camera, &other).png_bytes(),
            a,
            "{name}"
        );
    }
}
