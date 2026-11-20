//! Maps image pixels to rays.

use crate::ray::Ray;
use crate::vec3::{Point3, Vec3};

/// A pinhole camera at the origin looking down -z, with a viewport 2 units tall
/// one unit in front of it.
#[derive(Debug, Clone, Copy)]
pub struct Camera {
    pub image_width: u32,
    pub image_height: u32,
    origin: Point3,
    /// Top-left corner of the viewport.
    upper_left: Point3,
    /// One pixel step to the right and down, in world space.
    pixel_du: Vec3,
    pixel_dv: Vec3,
}

impl Camera {
    pub fn new(image_width: u32, image_height: u32) -> Self {
        let aspect = image_width as f64 / image_height as f64;
        let viewport_height = 2.0;
        let viewport_width = viewport_height * aspect;
        let focal_length = 1.0;
        let origin = Vec3::ZERO;

        let viewport_u = Vec3::new(viewport_width, 0.0, 0.0);
        let viewport_v = Vec3::new(0.0, -viewport_height, 0.0);
        let upper_left =
            origin - Vec3::new(0.0, 0.0, focal_length) - viewport_u / 2.0 - viewport_v / 2.0;
        Camera {
            image_width,
            image_height,
            origin,
            upper_left,
            pixel_du: viewport_u / image_width as f64,
            pixel_dv: viewport_v / image_height as f64,
        }
    }

    /// The ray through image position `(x, y)`, measured in pixels from the top-left
    /// corner. Pixel `(i, j)` covers `[i, i+1) x [j, j+1)`, so its center is `(i+0.5, j+0.5)`.
    pub fn ray_through(&self, x: f64, y: f64) -> Ray {
        let target = self.upper_left + x * self.pixel_du + y * self.pixel_dv;
        Ray::new(self.origin, target - self.origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Vec3, b: Vec3) -> bool {
        (a - b).length() < 1e-12
    }

    #[test]
    fn center_ray_looks_down_negative_z() {
        let cam = Camera::new(200, 100);
        let ray = cam.ray_through(100.0, 50.0);
        assert_eq!(ray.origin, Vec3::ZERO);
        assert!(close(ray.direction, Vec3::new(0.0, 0.0, -1.0)));
    }

    #[test]
    fn corners_span_the_viewport() {
        let cam = Camera::new(200, 100);
        // Aspect 2:1, so the viewport is 4 wide and 2 tall.
        assert!(close(
            cam.ray_through(0.0, 0.0).direction,
            Vec3::new(-2.0, 1.0, -1.0)
        ));
        assert!(close(
            cam.ray_through(200.0, 100.0).direction,
            Vec3::new(2.0, -1.0, -1.0)
        ));
        assert!(close(
            cam.ray_through(200.0, 0.0).direction,
            Vec3::new(2.0, 1.0, -1.0)
        ));
    }

    #[test]
    fn rows_go_down_and_columns_go_right() {
        let cam = Camera::new(16, 9);
        let a = cam.ray_through(0.5, 0.5).direction;
        let right = cam.ray_through(1.5, 0.5).direction;
        let down = cam.ray_through(0.5, 1.5).direction;
        assert!(right.x > a.x && right.y == a.y);
        assert!(down.y < a.y && down.x == a.x);
    }
}
