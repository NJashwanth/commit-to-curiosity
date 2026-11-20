//! A ray: a starting point and a direction.

use crate::vec3::{Point3, Vec3};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ray {
    pub origin: Point3,
    pub direction: Vec3,
}

impl Ray {
    pub fn new(origin: Point3, direction: Vec3) -> Self {
        Ray { origin, direction }
    }

    /// The point `origin + t * direction`.
    pub fn at(&self, t: f64) -> Point3 {
        self.origin + t * self.direction
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_walks_along_the_direction() {
        let ray = Ray::new(Vec3::new(1.0, 2.0, 3.0), Vec3::new(0.0, 0.0, -2.0));
        assert_eq!(ray.at(0.0), Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(ray.at(1.0), Vec3::new(1.0, 2.0, 1.0));
        assert_eq!(ray.at(2.5), Vec3::new(1.0, 2.0, -2.0));
        assert_eq!(ray.at(-1.0), Vec3::new(1.0, 2.0, 5.0));
    }
}
