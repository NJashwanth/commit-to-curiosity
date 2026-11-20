//! Tracing rays into colors, colors into pixels, and pixels into PNG files.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use indicatif::{ProgressBar, ProgressStyle};
use rand::Rng as _;
use rayon::prelude::*;

use crate::camera::Camera;
use crate::hittable::Hittable;
use crate::ray::Ray;
use crate::rng::{self, Rng};
use crate::vec3::Color;

/// An 8-bit RGB image, rows top to bottom.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, RGB.
    pub pixels: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32) -> Self {
        Image {
            width,
            height,
            pixels: vec![0; (width * height * 3) as usize],
        }
    }

    pub fn set(&mut self, x: u32, y: u32, rgb: [u8; 3]) {
        let i = ((y * self.width + x) * 3) as usize;
        self.pixels[i..i + 3].copy_from_slice(&rgb);
    }

    pub fn get(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.width + x) * 3) as usize;
        [self.pixels[i], self.pixels[i + 1], self.pixels[i + 2]]
    }

    /// Encode as PNG into any writer.
    pub fn write_png_to<W: Write>(&self, out: W) -> Result<(), png::EncodingError> {
        let mut encoder = png::Encoder::new(out, self.width, self.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Best);
        encoder.set_adaptive_filter(png::AdaptiveFilterType::Adaptive);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&self.pixels)?;
        writer.finish()
    }

    /// The PNG file as bytes.
    pub fn png_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        self.write_png_to(&mut bytes)
            .expect("encoding into a Vec cannot fail");
        bytes
    }

    /// Write a PNG file, creating parent directories as needed.
    pub fn save_png(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let file = BufWriter::new(File::create(path)?);
        self.write_png_to(file).map_err(std::io::Error::other)
    }
}

/// Map a color in `[0, 1]` to bytes, clamping anything out of range.
pub fn color_to_rgb(color: Color) -> [u8; 3] {
    let byte = |c: f64| {
        let c = if c.is_nan() { 0.0 } else { c.clamp(0.0, 0.999) };
        (256.0 * c) as u8
    };
    [byte(color.x), byte(color.y), byte(color.z)]
}

/// Gamma 2: image viewers expect brightness on a curve, not linear light.
/// Without this, a surface reflecting 50% of light looks far too dark.
pub fn linear_to_gamma(linear: f64) -> f64 {
    if linear > 0.0 { linear.sqrt() } else { 0.0 }
}

/// Average the samples of one pixel, gamma-correct, and convert to bytes.
pub fn finish_pixel(sum: Color, samples: u32) -> [u8; 3] {
    let avg = sum / samples as f64;
    color_to_rgb(Color::new(
        linear_to_gamma(avg.x),
        linear_to_gamma(avg.y),
        linear_to_gamma(avg.z),
    ))
}

/// The "hello world" image: red grows left to right, green grows bottom to top.
pub fn gradient(width: u32, height: u32) -> Image {
    let mut image = Image::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let r = x as f64 / (width - 1).max(1) as f64;
            let g = (height - 1 - y) as f64 / (height - 1).max(1) as f64;
            image.set(x, y, color_to_rgb(Color::new(r, g, 0.25)));
        }
    }
    image
}

/// The background: white at the horizon blending to light blue straight up.
pub fn sky(ray: &Ray) -> Color {
    let unit = ray.direction.unit();
    let a = 0.5 * (unit.y + 1.0);
    (1.0 - a) * Color::ONE + a * Color::new(0.5, 0.7, 1.0)
}

/// Surfaces start this far along a bounced ray. Without it, rounding puts the new
/// origin slightly inside the surface and the ray hits it again ("shadow acne").
pub const T_MIN: f64 = 0.001;

/// Follow a ray as it bounces around the scene, multiplying in each surface's
/// color, until it escapes to the sky, gets absorbed, or runs out of bounces.
pub fn ray_color(ray: &Ray, world: &dyn Hittable, max_depth: u32, rng: &mut Rng) -> Color {
    let mut ray = *ray;
    let mut throughput = Color::ONE;
    for _ in 0..max_depth {
        let Some(rec) = world.hit(&ray, T_MIN, f64::INFINITY) else {
            return throughput * sky(&ray);
        };
        let Some(scatter) = rec.material.scatter(&ray, &rec, rng) else {
            return Color::ZERO;
        };
        throughput = throughput * scatter.attenuation;
        ray = scatter.ray;
    }
    // Out of bounces: assume no more light arrives along this path.
    Color::ZERO
}

/// How much work to do per pixel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderSettings {
    /// Rays per pixel, each through a random point inside the pixel (antialiasing).
    pub samples_per_pixel: u32,
    /// Maximum bounces per ray.
    pub max_depth: u32,
    pub seed: u64,
}

impl Default for RenderSettings {
    fn default() -> Self {
        RenderSettings {
            samples_per_pixel: 100,
            max_depth: 50,
            seed: 1,
        }
    }
}

/// Render one row. Each row has its own random stream, so a row's pixels don't
/// depend on which rows were rendered before it.
pub fn render_row(
    world: &dyn Hittable,
    camera: &Camera,
    settings: &RenderSettings,
    y: u32,
) -> Vec<u8> {
    let mut rng = rng::stream(settings.seed, y as u64);
    let mut row = Vec::with_capacity(camera.image_width as usize * 3);
    for x in 0..camera.image_width {
        let mut sum = Color::ZERO;
        for _ in 0..settings.samples_per_pixel {
            let px = x as f64 + rng.random::<f64>();
            let py = y as f64 + rng.random::<f64>();
            let ray = camera.ray_through(px, py, &mut rng);
            sum += ray_color(&ray, world, settings.max_depth, &mut rng);
        }
        row.extend_from_slice(&finish_pixel(sum, settings.samples_per_pixel));
    }
    row
}

/// Render the whole image.
pub fn render(world: &dyn Hittable, camera: &Camera, settings: &RenderSettings) -> Image {
    render_with_progress(world, camera, settings, &ProgressBar::hidden())
}

/// Render the whole image, rows in parallel on rayon's thread pool, ticking
/// `progress` once per finished row. Rows are independent and each has its own
/// seeded random stream, so the result is the same on any number of threads.
pub fn render_with_progress(
    world: &dyn Hittable,
    camera: &Camera,
    settings: &RenderSettings,
    progress: &ProgressBar,
) -> Image {
    let mut image = Image::new(camera.image_width, camera.image_height);
    let row_bytes = camera.image_width as usize * 3;
    image
        .pixels
        .par_chunks_mut(row_bytes)
        .enumerate()
        .for_each(|(y, row)| {
            row.copy_from_slice(&render_row(world, camera, settings, y as u32));
            progress.inc(1);
        });
    image
}

/// A progress bar that counts rendered rows on stderr. It hides itself when
/// stderr isn't a terminal.
pub fn row_progress_bar(rows: u32) -> ProgressBar {
    let bar = ProgressBar::new(rows as u64);
    bar.set_style(
        ProgressStyle::with_template(
            "{spinner} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} rows (eta {eta})",
        )
        .expect("valid template")
        .progress_chars("=> "),
    );
    bar
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::CameraConfig;
    use crate::hittable::HittableList;
    use crate::material::Material;
    use crate::sphere::Sphere;
    use crate::vec3::Vec3;

    /// A pinhole camera at the origin looking down -z with a 90 degree field of view.
    fn test_camera(width: u32, height: u32) -> Camera {
        let config = CameraConfig {
            aspect_ratio: width as f64 / height as f64,
            ..CameraConfig::default()
        };
        Camera::new(&config, width)
    }

    fn gray_sphere(center: Vec3, radius: f64) -> Sphere {
        Sphere::new(
            center,
            radius,
            Material::lambertian(Color::new(0.5, 0.5, 0.5)),
        )
    }

    #[test]
    fn color_to_rgb_maps_and_clamps() {
        assert_eq!(color_to_rgb(Color::new(0.0, 0.5, 1.0)), [0, 128, 255]);
        assert_eq!(color_to_rgb(Color::new(-1.0, 2.0, f64::NAN)), [0, 255, 0]);
        assert_eq!(color_to_rgb(Color::new(0.25, 0.75, 0.999)), [64, 192, 255]);
    }

    #[test]
    fn gamma_is_square_root() {
        assert_eq!(linear_to_gamma(0.25), 0.5);
        assert_eq!(linear_to_gamma(1.0), 1.0);
        assert_eq!(linear_to_gamma(0.0), 0.0);
        assert_eq!(linear_to_gamma(-0.5), 0.0);
    }

    #[test]
    fn finish_pixel_averages_then_gamma_corrects() {
        // Four samples summing to 1.0 average to 0.25, which gamma maps to 0.5.
        let sum = Color::new(1.0, 0.0, 4.0);
        assert_eq!(finish_pixel(sum, 4), [128, 0, 255]);
    }

    #[test]
    fn set_and_get_pixels() {
        let mut image = Image::new(3, 2);
        assert_eq!(image.pixels.len(), 18);
        image.set(2, 1, [1, 2, 3]);
        assert_eq!(image.get(2, 1), [1, 2, 3]);
        assert_eq!(image.get(0, 0), [0, 0, 0]);
        assert_eq!(&image.pixels[15..18], &[1, 2, 3]);
    }

    #[test]
    fn gradient_corners() {
        let image = gradient(5, 4);
        // Top-left: no red, full green. Bottom-right: full red, no green.
        assert_eq!(image.get(0, 0), [0, 255, 64]);
        assert_eq!(image.get(4, 3), [255, 0, 64]);
        assert_eq!(image.get(4, 0), [255, 255, 64]);
        assert_eq!(image.get(0, 3), [0, 0, 64]);
    }

    #[test]
    fn png_round_trip() {
        let image = gradient(16, 9);
        let bytes = image.png_bytes();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");

        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (16, 9));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(&buf[..info.buffer_size()], &image.pixels[..]);
    }

    #[test]
    fn save_png_creates_directories() {
        let dir = std::env::temp_dir().join(format!("rt-save-{}", std::process::id()));
        let path = dir.join("nested/out.png");
        gradient(4, 4).save_png(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, gradient(4, 4).png_bytes());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_png_reports_io_errors() {
        // A path under a regular file can't be created.
        let file = std::env::temp_dir().join(format!("rt-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(gradient(2, 2).save_png(&file.join("out.png")).is_err());
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn sky_is_white_at_horizon_and_blue_overhead() {
        let up = sky(&Ray::new(Vec3::ZERO, Vec3::new(0.0, 3.0, 0.0)));
        assert_eq!(up, Color::new(0.5, 0.7, 1.0));
        let down = sky(&Ray::new(Vec3::ZERO, Vec3::new(0.0, -1.0, 0.0)));
        assert_eq!(down, Color::ONE);
        let level = sky(&Ray::new(Vec3::ZERO, Vec3::new(0.0, 0.0, -1.0)));
        assert_eq!(level, Color::new(0.75, 0.85, 1.0));
    }

    #[test]
    fn ray_color_misses_show_the_sky() {
        let world = HittableList::new();
        let ray = Ray::new(Vec3::ZERO, Vec3::new(0.3, 0.4, -1.0));
        let mut rng = rng::seeded(1);
        assert_eq!(ray_color(&ray, &world, 10, &mut rng), sky(&ray));
    }

    #[test]
    fn ray_color_is_black_when_out_of_bounces() {
        let sphere = gray_sphere(Vec3::new(0.0, 0.0, -2.0), 1.0);
        let ray = Ray::new(Vec3::ZERO, Vec3::new(0.0, 0.0, -1.0));
        let mut rng = rng::seeded(1);
        assert_eq!(ray_color(&ray, &sphere, 0, &mut rng), Color::ZERO);
        // One bounce: it hits the sphere and has no bounces left to reach the sky.
        assert_eq!(ray_color(&ray, &sphere, 1, &mut rng), Color::ZERO);
    }

    #[test]
    fn ray_color_absorbed_paths_are_black() {
        // Fuzzy metal hit at a grazing angle absorbs some rays; those return black.
        let metal = Sphere::new(
            Vec3::new(0.0, -100.0, 0.0),
            100.0,
            Material::metal(Color::ONE, 1.0),
        );
        let ray = Ray::new(Vec3::new(-10.0, 0.5, 0.0), Vec3::new(1.0, -0.05, 0.0));
        let mut rng = rng::seeded(2);
        let blacks = (0..500)
            .filter(|_| ray_color(&ray, &metal, 10, &mut rng) == Color::ZERO)
            .count();
        assert!(blacks > 0 && blacks < 500, "{blacks}");
    }

    #[test]
    fn glass_in_the_sky_transmits_the_sky() {
        // Clear glass absorbs nothing, so a ray through a lone glass ball comes out
        // somewhere in the sky at full strength: every channel between sky colors.
        let glass = Sphere::new(Vec3::new(0.0, 0.0, -3.0), 1.0, Material::dielectric(1.5));
        let ray = Ray::new(Vec3::ZERO, Vec3::new(0.1, 0.1, -1.0));
        let mut rng = rng::seeded(4);
        for _ in 0..100 {
            let c = ray_color(&ray, &glass, 50, &mut rng);
            assert!((0.5..=1.0).contains(&c.x) && c.z == 1.0, "{c:?}");
        }
    }

    #[test]
    fn ray_color_halves_light_per_bounce() {
        // From outside a lone convex sphere, one bounce always escapes to the sky.
        let sphere = gray_sphere(Vec3::new(0.0, 0.0, -2.0), 1.0);
        let ray = Ray::new(Vec3::ZERO, Vec3::new(0.0, 0.0, -1.0));
        let mut rng = rng::seeded(5);
        for _ in 0..100 {
            let c = ray_color(&ray, &sphere, 5, &mut rng);
            // Half of a sky color: between (0.25, 0.35, 0.5) and (0.5, 0.5, 0.5).
            assert!(c.z == 0.5 && (0.25..=0.5).contains(&c.x));
        }
    }

    /// A huge sphere whose surface is (almost) the plane x = 0 just left of the
    /// camera: rays heading left hit it, rays heading right see the sky.
    fn half_world() -> Sphere {
        gray_sphere(Vec3::new(-1000.0, 0.0, -1.0), 1000.0)
    }

    #[test]
    fn antialiasing_blends_pixels_on_an_edge() {
        // 5x2 image: viewport is 5 wide, so the middle column straddles x = 0.
        let camera = test_camera(5, 2);
        let one_bounce = |spp| RenderSettings {
            samples_per_pixel: spp,
            max_depth: 1,
            seed: 3,
        };
        let sharp = render(&half_world(), &camera, &one_bounce(1));
        let smooth = render(&half_world(), &camera, &one_bounce(256));

        // Left columns hit the black wall, right columns see the sky.
        assert_eq!(smooth.get(0, 0), [0, 0, 0]);
        assert_eq!(smooth.get(1, 1), [0, 0, 0]);
        assert!(smooth.get(4, 0)[2] == 255);

        // With one sample the edge pixel is all-or-nothing; with many it's in between.
        let edge = sharp.get(2, 0);
        assert!(edge == [0, 0, 0] || edge[2] == 255);
        let blended = smooth.get(2, 0);
        assert!(blended[2] > 100 && blended[2] < 250, "{blended:?}");
    }

    #[test]
    fn same_seed_gives_identical_bytes() {
        let mut world = HittableList::new();
        world.add(gray_sphere(Vec3::new(0.0, 0.0, -1.0), 0.5));
        world.add(gray_sphere(Vec3::new(0.0, -100.5, -1.0), 100.0));
        let camera = test_camera(32, 18);
        let settings = RenderSettings {
            samples_per_pixel: 4,
            max_depth: 8,
            seed: 42,
        };
        let a = render(&world, &camera, &settings).png_bytes();
        let b = render(&world, &camera, &settings).png_bytes();
        assert_eq!(a, b);

        let other = RenderSettings {
            seed: 43,
            ..settings
        };
        assert_ne!(render(&world, &camera, &other).png_bytes(), a);
    }

    #[test]
    fn depth_of_field_render_is_also_deterministic() {
        let mut world = HittableList::new();
        world.add(gray_sphere(Vec3::new(0.0, 0.0, -1.0), 0.5));
        let config = CameraConfig {
            aperture: 0.5,
            ..CameraConfig::default()
        };
        let camera = Camera::new(&config, 24);
        let settings = RenderSettings {
            samples_per_pixel: 2,
            max_depth: 4,
            seed: 7,
        };
        assert_eq!(
            render(&world, &camera, &settings),
            render(&world, &camera, &settings)
        );
    }

    #[test]
    fn rows_render_independently() {
        let world = half_world();
        let camera = test_camera(8, 4);
        let settings = RenderSettings {
            samples_per_pixel: 3,
            max_depth: 2,
            seed: 9,
        };
        let image = render(&world, &camera, &settings);
        let row2 = render_row(&world, &camera, &settings, 2);
        assert_eq!(&image.pixels[2 * 8 * 3..3 * 8 * 3], &row2[..]);
    }

    fn small_scene() -> HittableList {
        let mut world = HittableList::new();
        world.add(gray_sphere(Vec3::new(0.0, -100.5, -1.0), 100.0));
        world.add(Sphere::new(
            Vec3::new(-0.6, 0.0, -1.0),
            0.5,
            Material::dielectric(1.5),
        ));
        world.add(Sphere::new(
            Vec3::new(0.6, 0.0, -1.0),
            0.5,
            Material::metal(Color::new(0.8, 0.6, 0.2), 0.3),
        ));
        world
    }

    #[test]
    fn thread_count_does_not_change_the_image() {
        let world = small_scene();
        let camera = test_camera(32, 18);
        let settings = RenderSettings {
            samples_per_pixel: 4,
            max_depth: 10,
            seed: 11,
        };
        let on = |threads| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| render(&world, &camera, &settings).png_bytes())
        };
        let one = on(1);
        assert_eq!(on(2), one);
        assert_eq!(on(8), one);
    }

    #[test]
    fn progress_counts_every_row() {
        let world = small_scene();
        let camera = test_camera(16, 9);
        let settings = RenderSettings {
            samples_per_pixel: 1,
            max_depth: 3,
            seed: 1,
        };
        let bar = ProgressBar::hidden();
        bar.set_length(9);
        render_with_progress(&world, &camera, &settings, &bar);
        assert_eq!(bar.position(), 9);
        assert_eq!(row_progress_bar(9).length(), Some(9));
    }
}
