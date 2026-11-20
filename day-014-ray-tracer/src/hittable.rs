//! Anything a ray can hit.

use crate::ray::Ray;
use crate::vec3::{Point3, Vec3};

/// Where a ray hit a surface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitRecord {
    pub point: Point3,
    /// Unit normal, always pointing against the incoming ray.
    pub normal: Vec3,
    pub t: f64,
    /// True when the ray hit the outside of the surface.
    pub front_face: bool,
}

impl HitRecord {
    /// Build a record from the geometric outward normal (unit length), flipping it
    /// so it faces the ray. Materials need to know which side they were hit from.
    pub fn new(ray: &Ray, t: f64, outward_normal: Vec3) -> Self {
        let (front_face, normal) = face_normal(ray, outward_normal);
        HitRecord {
            point: ray.at(t),
            normal,
            t,
            front_face,
        }
    }
}

/// `(front_face, normal)`: the outward normal if the ray comes from outside,
/// otherwise the flipped normal. A grazing ray (perpendicular to the normal) counts
/// as outside: a ray that starts inside always leaves with a positive dot product.
pub fn face_normal(ray: &Ray, outward_normal: Vec3) -> (bool, Vec3) {
    let front_face = ray.direction.dot(outward_normal) <= 0.0;
    let normal = if front_face {
        outward_normal
    } else {
        -outward_normal
    };
    (front_face, normal)
}

/// A shape that can be intersected. Add a new shape by implementing this.
pub trait Hittable: Send + Sync {
    /// The nearest hit with `t_min < t < t_max`, if any.
    fn hit(&self, ray: &Ray, t_min: f64, t_max: f64) -> Option<HitRecord>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn face_normal_keeps_outward_normal_for_outside_hits() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        let (front, n) = face_normal(&ray, Vec3::new(0.0, 0.0, 1.0));
        assert!(front);
        assert_eq!(n, Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn face_normal_flips_for_inside_hits() {
        let ray = Ray::new(Vec3::ZERO, Vec3::new(0.0, 0.0, -1.0));
        let (front, n) = face_normal(&ray, Vec3::new(0.0, 0.0, -1.0));
        assert!(!front);
        assert_eq!(n, Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn grazing_ray_counts_as_outside() {
        let ray = Ray::new(Vec3::new(0.0, 1.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        let (front, n) = face_normal(&ray, Vec3::new(0.0, 1.0, 0.0));
        assert!(front);
        assert_eq!(n, Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn record_stores_point_and_facing_normal() {
        let ray = Ray::new(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -1.0));
        let rec = HitRecord::new(&ray, 4.0, Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(rec.point, Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(rec.t, 4.0);
        assert!(rec.front_face);
        assert!(rec.normal.dot(ray.direction) < 0.0);
    }
}
