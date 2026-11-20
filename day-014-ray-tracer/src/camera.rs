//! A positionable thin-lens camera: where it is, what it looks at, how wide it
//! sees, and how much is in focus.

use crate::ray::Ray;
use crate::rng::Rng;
use crate::vec3::{Point3, Vec3, random_in_unit_disk};

/// Everything you'd set on a real camera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraConfig {
    pub look_from: Point3,
    pub look_at: Point3,
    /// Which way is "up" for the picture (it doesn't have to be exactly
    /// perpendicular to the view direction, just not parallel to it).
    pub vup: Vec3,
    /// Vertical field of view in degrees.
    pub vfov: f64,
    /// Width / height of the image.
    pub aspect_ratio: f64,
    /// Lens diameter. 0 is a pinhole: everything is sharp.
    pub aperture: f64,
    /// Distance from `look_from` to the plane that's perfectly in focus.
    pub focus_dist: f64,
}

impl Default for CameraConfig {
    fn default() -> Self {
        CameraConfig {
            look_from: Vec3::ZERO,
            look_at: Vec3::new(0.0, 0.0, -1.0),
            vup: Vec3::new(0.0, 1.0, 0.0),
            vfov: 90.0,
            aspect_ratio: 16.0 / 9.0,
            aperture: 0.0,
            focus_dist: 1.0,
        }
    }
}

impl CameraConfig {
    /// Check the settings make a usable camera.
    pub fn validate(&self) -> Result<(), String> {
        // First, because a default focus distance would be 0 here too.
        let forward = self.look_at - self.look_from;
        if forward.near_zero() {
            return Err("look_from and look_at must be different points".into());
        }
        if !(self.vfov > 0.0 && self.vfov < 180.0) {
            return Err(format!(
                "vfov must be between 0 and 180 degrees, got {}",
                self.vfov
            ));
        }
        if !(self.aspect_ratio > 0.0 && self.aspect_ratio.is_finite()) {
            return Err(format!(
                "aspect_ratio must be positive, got {}",
                self.aspect_ratio
            ));
        }
        if !(self.aperture >= 0.0 && self.aperture.is_finite()) {
            return Err(format!("aperture must be 0 or more, got {}", self.aperture));
        }
        if !(self.focus_dist > 0.0 && self.focus_dist.is_finite()) {
            return Err(format!(
                "focus_dist must be positive, got {}",
                self.focus_dist
            ));
        }
        if self.vup.cross(forward).near_zero() {
            return Err("vup must not be parallel to the view direction".into());
        }
        Ok(())
    }

    /// Image height for a given width, from the aspect ratio (at least 1 pixel).
    pub fn image_height(&self, image_width: u32) -> u32 {
        ((image_width as f64 / self.aspect_ratio).round() as u32).max(1)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Camera {
    pub image_width: u32,
    pub image_height: u32,
    origin: Point3,
    /// Top-left corner of the viewport, which sits on the focus plane.
    upper_left: Point3,
    /// One pixel step to the right and down, in world space.
    pixel_du: Vec3,
    pixel_dv: Vec3,
    /// Camera basis: `u` points right, `v` up, `w` backwards (away from the scene).
    u: Vec3,
    v: Vec3,
    w: Vec3,
    lens_radius: f64,
}

impl Camera {
    /// Build a camera for an image `image_width` pixels wide. The height comes from
    /// the aspect ratio. The config should pass [`CameraConfig::validate`].
    pub fn new(config: &CameraConfig, image_width: u32) -> Self {
        let image_height = config.image_height(image_width);

        // The viewport is placed on the focus plane, so rays from anywhere on the
        // lens that aim at the same viewport point meet there: that's what's sharp.
        let half_height = (config.vfov.to_radians() / 2.0).tan();
        let viewport_height = 2.0 * half_height * config.focus_dist;
        // Use the real pixel ratio, so pixels stay square after rounding the height.
        let viewport_width = viewport_height * image_width as f64 / image_height as f64;

        let w = (config.look_from - config.look_at).unit();
        let u = config.vup.cross(w).unit();
        let v = w.cross(u);

        let viewport_u = viewport_width * u;
        let viewport_v = -viewport_height * v;
        let upper_left =
            config.look_from - config.focus_dist * w - viewport_u / 2.0 - viewport_v / 2.0;

        Camera {
            image_width,
            image_height,
            origin: config.look_from,
            upper_left,
            pixel_du: viewport_u / image_width as f64,
            pixel_dv: viewport_v / image_height as f64,
            u,
            v,
            w,
            lens_radius: config.aperture / 2.0,
        }
    }

    /// The ray through image position `(x, y)`, measured in pixels from the top-left
    /// corner. Pixel `(i, j)` covers `[i, i+1) x [j, j+1)`. With an aperture, the ray
    /// starts at a random point on the lens, which blurs anything off the focus plane.
    ///
    /// The direction is scaled so that `ray.at(1.0)` is the point on the focus plane.
    pub fn ray_through(&self, x: f64, y: f64, rng: &mut Rng) -> Ray {
        let target = self.upper_left + x * self.pixel_du + y * self.pixel_dv;
        let origin = if self.lens_radius > 0.0 {
            let p = self.lens_radius * random_in_unit_disk(rng);
            self.origin + p.x * self.u + p.y * self.v
        } else {
            self.origin
        };
        Ray::new(origin, target - origin)
    }

    /// The direction the camera is looking (unit length).
    pub fn forward(&self) -> Vec3 {
        -self.w
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::seeded;

    fn close(a: Vec3, b: Vec3) -> bool {
        (a - b).length() < 1e-9
    }

    fn camera(config: CameraConfig, width: u32) -> Camera {
        config.validate().unwrap();
        Camera::new(&config, width)
    }

    #[test]
    fn default_camera_looks_down_negative_z() {
        let cam = camera(CameraConfig::default(), 160);
        assert_eq!((cam.image_width, cam.image_height), (160, 90));
        let ray = cam.ray_through(80.0, 45.0, &mut seeded(1));
        assert_eq!(ray.origin, Vec3::ZERO);
        assert!(close(ray.direction, Vec3::new(0.0, 0.0, -1.0)));
        assert!(close(cam.forward(), Vec3::new(0.0, 0.0, -1.0)));
    }

    #[test]
    fn ninety_degree_fov_spans_one_unit_each_way() {
        // A 2:1 image with vfov 90 at focus distance 1: the viewport is 4 x 2.
        let config = CameraConfig {
            aspect_ratio: 2.0,
            ..CameraConfig::default()
        };
        let cam = camera(config, 200);
        let mut rng = seeded(1);
        assert!(close(
            cam.ray_through(0.0, 0.0, &mut rng).direction,
            Vec3::new(-2.0, 1.0, -1.0)
        ));
        assert!(close(
            cam.ray_through(200.0, 100.0, &mut rng).direction,
            Vec3::new(2.0, -1.0, -1.0)
        ));
        // Top-center is 45 degrees above the view direction (half of 90).
        let top = cam.ray_through(100.0, 0.0, &mut rng).direction.unit();
        assert!((top.dot(Vec3::new(0.0, 0.0, -1.0)).acos().to_degrees() - 45.0).abs() < 1e-9);
    }

    #[test]
    fn vertical_fov_sets_the_angle_to_the_top_edge() {
        for vfov in [20.0, 40.0, 60.0, 120.0] {
            let config = CameraConfig {
                vfov,
                focus_dist: 7.0,
                ..CameraConfig::default()
            };
            let cam = camera(config, 64);
            let top = cam.ray_through(32.0, 0.0, &mut seeded(1)).direction.unit();
            let angle = top.dot(cam.forward()).acos().to_degrees();
            assert!((angle - vfov / 2.0).abs() < 1e-9, "vfov {vfov}: {angle}");
        }
    }

    #[test]
    fn center_ray_points_at_look_at() {
        let config = CameraConfig {
            look_from: Vec3::new(13.0, 2.0, 3.0),
            look_at: Vec3::new(0.0, 0.5, 0.0),
            vfov: 20.0,
            ..CameraConfig::default()
        };
        let cam = camera(config, 320);
        let ray = cam.ray_through(160.0, 90.0, &mut seeded(1));
        let expected = (config.look_at - config.look_from).unit();
        assert!(close(ray.direction.unit(), expected));
        assert!(close(cam.forward(), expected));
    }

    #[test]
    fn up_is_up_and_right_is_right() {
        // Looking along +x with y up, so "right" in the image is +z.
        let config = CameraConfig {
            look_at: Vec3::new(1.0, 0.0, 0.0),
            ..CameraConfig::default()
        };
        let cam = camera(config, 32);
        let mut rng = seeded(1);
        let top = cam.ray_through(16.0, 0.0, &mut rng).direction;
        let bottom = cam.ray_through(16.0, 18.0, &mut rng).direction;
        let left = cam.ray_through(0.0, 9.0, &mut rng).direction;
        let right = cam.ray_through(32.0, 9.0, &mut rng).direction;
        assert!(top.y > 0.0 && bottom.y < 0.0);
        assert!(right.z > 0.0 && left.z < 0.0);
    }

    #[test]
    fn aspect_ratio_sets_the_height() {
        let cfg = |aspect_ratio| CameraConfig {
            aspect_ratio,
            ..CameraConfig::default()
        };
        assert_eq!(cfg(16.0 / 9.0).image_height(400), 225);
        assert_eq!(cfg(1.0).image_height(300), 300);
        assert_eq!(cfg(3.0 / 2.0).image_height(1200), 800);
        assert_eq!(cfg(1000.0).image_height(10), 1);
    }

    #[test]
    fn pinhole_rays_all_start_at_look_from() {
        let config = CameraConfig {
            look_from: Vec3::new(1.0, 2.0, 3.0),
            ..CameraConfig::default()
        };
        let cam = camera(config, 32);
        let mut rng = seeded(2);
        for _ in 0..100 {
            assert_eq!(
                cam.ray_through(10.0, 5.0, &mut rng).origin,
                config.look_from
            );
        }
    }

    #[test]
    fn aperture_spreads_origins_over_the_lens() {
        let config = CameraConfig {
            look_from: Vec3::new(0.0, 0.0, 5.0),
            look_at: Vec3::ZERO,
            aperture: 0.8,
            focus_dist: 5.0,
            ..CameraConfig::default()
        };
        let cam = camera(config, 32);
        let mut rng = seeded(3);
        let mut farthest: f64 = 0.0;
        for _ in 0..500 {
            let ray = cam.ray_through(16.0, 9.0, &mut rng);
            let offset = ray.origin - config.look_from;
            // On the lens: within the radius, in the plane facing the scene.
            assert!(offset.length() < 0.4 + 1e-12);
            assert!(offset.z.abs() < 1e-12);
            farthest = farthest.max(offset.length());
        }
        assert!(farthest > 0.3);
    }

    #[test]
    fn rays_through_one_pixel_meet_on_the_focus_plane() {
        let config = CameraConfig {
            look_from: Vec3::new(-2.0, 2.0, 1.0),
            look_at: Vec3::new(0.0, 0.0, -1.0),
            vfov: 20.0,
            aperture: 2.0,
            focus_dist: 3.0,
            ..CameraConfig::default()
        };
        let cam = camera(config, 64);
        let mut rng = seeded(4);
        let first = cam.ray_through(20.0, 10.0, &mut rng);
        let focus_point = first.at(1.0);
        // The point is on the focus plane: 3 units along the view direction.
        let depth = (focus_point - config.look_from).dot(cam.forward());
        assert!((depth - 3.0).abs() < 1e-9);
        for _ in 0..100 {
            let ray = cam.ray_through(20.0, 10.0, &mut rng);
            assert_ne!(ray.origin, first.origin);
            assert!(close(ray.at(1.0), focus_point));
        }
    }

    #[test]
    fn validate_rejects_bad_settings() {
        let ok = CameraConfig::default();
        assert!(ok.validate().is_ok());
        let err = |c: CameraConfig| c.validate().unwrap_err();
        assert!(err(CameraConfig { vfov: 0.0, ..ok }).contains("vfov"));
        assert!(err(CameraConfig { vfov: 180.0, ..ok }).contains("vfov"));
        assert!(
            err(CameraConfig {
                vfov: f64::NAN,
                ..ok
            })
            .contains("vfov")
        );
        assert!(
            err(CameraConfig {
                aspect_ratio: -1.0,
                ..ok
            })
            .contains("aspect_ratio")
        );
        assert!(
            err(CameraConfig {
                aperture: -0.1,
                ..ok
            })
            .contains("aperture")
        );
        assert!(
            err(CameraConfig {
                focus_dist: 0.0,
                ..ok
            })
            .contains("focus_dist")
        );
        assert!(
            err(CameraConfig {
                look_at: ok.look_from,
                ..ok
            })
            .contains("different")
        );
        let straight_down = CameraConfig {
            look_at: Vec3::new(0.0, -5.0, 0.0),
            ..ok
        };
        assert!(err(straight_down).contains("vup"));
    }
}
