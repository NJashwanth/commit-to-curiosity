//! Anything a ray can hit.

use crate::material::Material;
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
    /// The material of the surface that was hit.
    pub material: Material,
}

impl HitRecord {
    /// Build a record from the geometric outward normal (unit length), flipping it
    /// so it faces the ray. Materials need to know which side they were hit from.
    pub fn new(ray: &Ray, t: f64, outward_normal: Vec3, material: Material) -> Self {
        let (front_face, normal) = face_normal(ray, outward_normal);
        HitRecord {
            point: ray.at(t),
            normal,
            t,
            front_face,
            material,
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

/// A plain list of objects. A ray is tested against every one, keeping the closest.
#[derive(Default)]
pub struct HittableList {
    pub objects: Vec<Box<dyn Hittable>>,
}

impl HittableList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add<H: Hittable + 'static>(&mut self, object: H) {
        self.objects.push(Box::new(object));
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }
}

impl Hittable for HittableList {
    fn hit(&self, ray: &Ray, t_min: f64, t_max: f64) -> Option<HitRecord> {
        let mut closest: Option<HitRecord> = None;
        for object in &self.objects {
            // Anything farther than the best hit so far can't win.
            let limit = closest.map_or(t_max, |rec| rec.t);
            if let Some(rec) = object.hit(ray, t_min, limit) {
                closest = Some(rec);
            }
        }
        closest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::Sphere;
    use crate::vec3::Color;

    fn sphere(center: Vec3, radius: f64) -> Sphere {
        Sphere::new(center, radius, Material::lambertian(Color::ONE))
    }

    fn ray_down_z() -> Ray {
        Ray::new(Vec3::new(0.0, 0.0, 10.0), Vec3::new(0.0, 0.0, -1.0))
    }

    fn row_of_spheres() -> HittableList {
        let mut list = HittableList::new();
        // Added far-to-near so the closest isn't simply the first or last.
        list.add(sphere(Vec3::new(0.0, 0.0, -5.0), 1.0));
        list.add(sphere(Vec3::new(0.0, 0.0, 5.0), 1.0));
        list.add(sphere(Vec3::new(0.0, 0.0, 0.0), 1.0));
        list
    }

    #[test]
    fn list_returns_the_closest_hit() {
        let list = row_of_spheres();
        assert_eq!(list.len(), 3);
        let rec = list.hit(&ray_down_z(), 0.0, f64::INFINITY).unwrap();
        assert_eq!(rec.t, 4.0);
        assert_eq!(rec.point, Vec3::new(0.0, 0.0, 6.0));
    }

    #[test]
    fn list_respects_t_bounds() {
        let list = row_of_spheres();
        // Skip the first sphere entirely (t in 4..6): the next surface is at t = 9.
        assert_eq!(list.hit(&ray_down_z(), 6.5, f64::INFINITY).unwrap().t, 9.0);
        assert!(list.hit(&ray_down_z(), 0.0, 3.0).is_none());
    }

    #[test]
    fn empty_list_never_hits() {
        let list = HittableList::new();
        assert!(list.is_empty());
        assert!(list.hit(&ray_down_z(), 0.0, f64::INFINITY).is_none());
    }

    #[test]
    fn list_misses_when_nothing_is_in_the_way() {
        let list = row_of_spheres();
        let ray = Ray::new(Vec3::new(5.0, 0.0, 10.0), Vec3::new(0.0, 0.0, -1.0));
        assert!(list.hit(&ray, 0.0, f64::INFINITY).is_none());
    }

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
        let metal = Material::metal(Color::ONE, 0.0);
        let rec = HitRecord::new(&ray, 4.0, Vec3::new(0.0, 0.0, 1.0), metal);
        assert_eq!(rec.point, Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(rec.t, 4.0);
        assert!(rec.front_face);
        assert!(rec.normal.dot(ray.direction) < 0.0);
        assert_eq!(rec.material, metal);
    }
}
