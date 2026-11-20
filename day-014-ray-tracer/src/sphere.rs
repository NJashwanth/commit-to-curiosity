//! Spheres, the only shape so far.

use crate::hittable::{HitRecord, Hittable};
use crate::material::Material;
use crate::ray::Ray;
use crate::vec3::Point3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sphere {
    pub center: Point3,
    pub radius: f64,
    pub material: Material,
}

impl Sphere {
    pub fn new(center: Point3, radius: f64, material: Material) -> Self {
        Sphere {
            center,
            radius,
            material,
        }
    }
}

impl Hittable for Sphere {
    /// Solve |origin + t*dir - center|^2 = r^2 for t. With `oc = center - origin`
    /// and `h = dir . oc` this is a*t^2 - 2h*t + c = 0, so t = (h ± sqrt(h^2 - ac)) / a.
    fn hit(&self, ray: &Ray, t_min: f64, t_max: f64) -> Option<HitRecord> {
        let oc = self.center - ray.origin;
        let a = ray.direction.length_squared();
        let h = ray.direction.dot(oc);
        let c = oc.length_squared() - self.radius * self.radius;
        let discriminant = h * h - a * c;
        if discriminant < 0.0 {
            return None;
        }
        let sqrtd = discriminant.sqrt();

        // Try the nearer root first, then the farther one.
        let mut t = (h - sqrtd) / a;
        if t <= t_min || t >= t_max {
            t = (h + sqrtd) / a;
            if t <= t_min || t >= t_max {
                return None;
            }
        }
        let outward_normal = (ray.at(t) - self.center) / self.radius;
        Some(HitRecord::new(ray, t, outward_normal, self.material))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vec3::{Color, Vec3};

    fn gray() -> Material {
        Material::lambertian(Color::new(0.5, 0.5, 0.5))
    }

    fn unit_sphere() -> Sphere {
        Sphere::new(Vec3::ZERO, 1.0, gray())
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn head_on_hit_returns_the_near_side() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        let rec = unit_sphere().hit(&ray, 0.0, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 4.0);
        assert_eq!(rec.point, Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(rec.normal, Vec3::new(0.0, 0.0, 1.0));
        assert!(rec.front_face);
    }

    #[test]
    fn unnormalized_direction_gives_scaled_t() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -2.0));
        let rec = unit_sphere().hit(&ray, 0.0, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 2.0);
        assert_eq!(rec.point, Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn miss() {
        let ray = Ray::new(Vec3::new(0.0, 2.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        assert!(unit_sphere().hit(&ray, 0.0, f64::INFINITY).is_none());
        // Pointing away from the sphere.
        let away = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, 1.0));
        assert!(unit_sphere().hit(&away, 0.0, f64::INFINITY).is_none());
    }

    #[test]
    fn tangent_hit_touches_one_point() {
        let ray = Ray::new(Vec3::new(0.0, 1.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        let rec = unit_sphere().hit(&ray, 0.0, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 5.0);
        assert_eq!(rec.point, Vec3::new(0.0, 1.0, 0.0));
        assert_eq!(rec.normal, Vec3::new(0.0, 1.0, 0.0));
        // Just above the top grazes past.
        let above = Ray::new(Vec3::new(0.0, 1.0 + 1e-9, 5.0), Vec3::new(0.0, 0.0, -1.0));
        assert!(unit_sphere().hit(&above, 0.0, f64::INFINITY).is_none());
    }

    #[test]
    fn ray_starting_inside_hits_the_far_wall_with_flipped_normal() {
        let ray = Ray::new(Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0));
        let rec = unit_sphere().hit(&ray, 0.001, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 1.0);
        assert_eq!(rec.point, Vec3::new(1.0, 0.0, 0.0));
        assert!(!rec.front_face);
        // Outward normal is +x; the stored normal faces back toward the ray.
        assert_eq!(rec.normal, Vec3::new(-1.0, 0.0, 0.0));
    }

    #[test]
    fn t_min_skips_the_near_root() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        // Near root t=4 is excluded, so the far root t=6 is returned (from inside).
        let rec = unit_sphere().hit(&ray, 4.5, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 6.0);
        assert!(!rec.front_face);
        assert_eq!(rec.normal, Vec3::new(0.0, 0.0, 1.0));
        // Both roots excluded.
        assert!(unit_sphere().hit(&ray, 6.5, f64::INFINITY).is_none());
    }

    #[test]
    fn t_max_cuts_off_hits() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        assert!(unit_sphere().hit(&ray, 0.0, 3.9).is_none());
        assert_eq!(unit_sphere().hit(&ray, 0.0, 4.1).unwrap().t, 4.0);
    }

    #[test]
    fn bounds_are_exclusive() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        // t == t_max is not a hit, and t == t_min falls through to the far root.
        assert!(unit_sphere().hit(&ray, 0.0, 4.0).is_none());
        assert_eq!(unit_sphere().hit(&ray, 4.0, 10.0).unwrap().t, 6.0);
    }

    #[test]
    fn hit_behind_the_origin_is_ignored() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, -5.0), Vec3::new(0.0, 0.0, -1.0));
        assert!(unit_sphere().hit(&ray, 0.0, f64::INFINITY).is_none());
    }

    #[test]
    fn off_center_sphere_normal_is_unit_length() {
        let sphere = Sphere::new(Vec3::new(1.0, 2.0, -3.0), 0.5, gray());
        let ray = Ray::new(Vec3::ZERO, Vec3::new(1.0, 2.0, -2.6));
        let rec = sphere.hit(&ray, 0.0, f64::INFINITY).unwrap();
        assert!(close(rec.normal.length(), 1.0));
        assert!(close((rec.point - sphere.center).length(), 0.5));
        assert!(rec.front_face);
        assert_eq!(rec.material, gray());
    }
}
