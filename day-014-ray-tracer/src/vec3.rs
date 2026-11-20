//! A small 3D vector type used for points, directions and colors.

use std::ops::{Add, AddAssign, Div, DivAssign, Index, Mul, MulAssign, Neg, Sub, SubAssign};

use rand::Rng;

/// Three `f64` components. The same type is used for points, directions and RGB colors.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// A position in space.
pub type Point3 = Vec3;
/// A linear RGB color, each channel nominally in `[0, 1]`.
pub type Color = Vec3;

impl Vec3 {
    pub const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);
    pub const ONE: Vec3 = Vec3::new(1.0, 1.0, 1.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Vec3 { x, y, z }
    }

    pub fn length(self) -> f64 {
        self.length_squared().sqrt()
    }

    pub fn length_squared(self) -> f64 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    pub fn dot(self, other: Vec3) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    /// The vector scaled to length 1.
    pub fn unit(self) -> Vec3 {
        self / self.length()
    }

    /// True when every component is tiny, so the vector is effectively zero.
    pub fn near_zero(self) -> bool {
        const EPS: f64 = 1e-8;
        self.x.abs() < EPS && self.y.abs() < EPS && self.z.abs() < EPS
    }

    pub fn min(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.x.min(other.x),
            self.y.min(other.y),
            self.z.min(other.z),
        )
    }

    pub fn max(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.x.max(other.x),
            self.y.max(other.y),
            self.z.max(other.z),
        )
    }

    /// A vector with each component uniform in `[0, 1)`.
    pub fn random<R: Rng + ?Sized>(rng: &mut R) -> Vec3 {
        Vec3::new(rng.random(), rng.random(), rng.random())
    }

    /// A vector with each component uniform in `[min, max)`.
    pub fn random_range<R: Rng + ?Sized>(rng: &mut R, min: f64, max: f64) -> Vec3 {
        Vec3::new(
            rng.random_range(min..max),
            rng.random_range(min..max),
            rng.random_range(min..max),
        )
    }
}

/// A uniformly distributed point strictly inside the unit sphere (rejection sampling).
pub fn random_in_unit_sphere<R: Rng + ?Sized>(rng: &mut R) -> Vec3 {
    loop {
        let p = Vec3::random_range(rng, -1.0, 1.0);
        if p.length_squared() < 1.0 {
            return p;
        }
    }
}

/// A uniformly distributed direction: a point on the surface of the unit sphere.
pub fn random_unit_vector<R: Rng + ?Sized>(rng: &mut R) -> Vec3 {
    loop {
        let p = random_in_unit_sphere(rng);
        let len_sq = p.length_squared();
        // Points very close to the center would blow up when normalized.
        if len_sq > 1e-160 {
            return p / len_sq.sqrt();
        }
    }
}

/// A uniformly distributed point inside the unit disk in the z = 0 plane.
pub fn random_in_unit_disk<R: Rng + ?Sized>(rng: &mut R) -> Vec3 {
    loop {
        let p = Vec3::new(
            rng.random_range(-1.0..1.0),
            rng.random_range(-1.0..1.0),
            0.0,
        );
        if p.length_squared() < 1.0 {
            return p;
        }
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// Component-wise product, used to tint one color by another.
impl Mul for Vec3 {
    type Output = Vec3;
    fn mul(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x * o.x, self.y * o.y, self.z * o.z)
    }
}

impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, t: f64) -> Vec3 {
        Vec3::new(self.x * t, self.y * t, self.z * t)
    }
}

impl Mul<Vec3> for f64 {
    type Output = Vec3;
    fn mul(self, v: Vec3) -> Vec3 {
        v * self
    }
}

impl Div<f64> for Vec3 {
    type Output = Vec3;
    fn div(self, t: f64) -> Vec3 {
        self * (1.0 / t)
    }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) {
        *self = *self + o;
    }
}

impl SubAssign for Vec3 {
    fn sub_assign(&mut self, o: Vec3) {
        *self = *self - o;
    }
}

impl MulAssign<f64> for Vec3 {
    fn mul_assign(&mut self, t: f64) {
        *self = *self * t;
    }
}

impl DivAssign<f64> for Vec3 {
    fn div_assign(&mut self, t: f64) {
        *self = *self / t;
    }
}

/// `v[0]`, `v[1]`, `v[2]` are x, y, z. Handy for per-axis loops.
impl Index<usize> for Vec3 {
    type Output = f64;
    fn index(&self, axis: usize) -> &f64 {
        match axis {
            0 => &self.x,
            1 => &self.y,
            2 => &self.z,
            _ => panic!("Vec3 axis out of range: {axis}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::seeded;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn arithmetic_operators() {
        let a = Vec3::new(1.0, 2.0, 3.0);
        let b = Vec3::new(4.0, -5.0, 6.0);
        assert_eq!(a + b, Vec3::new(5.0, -3.0, 9.0));
        assert_eq!(a - b, Vec3::new(-3.0, 7.0, -3.0));
        assert_eq!(-a, Vec3::new(-1.0, -2.0, -3.0));
        assert_eq!(a * b, Vec3::new(4.0, -10.0, 18.0));
        assert_eq!(a * 2.0, Vec3::new(2.0, 4.0, 6.0));
        assert_eq!(2.0 * a, Vec3::new(2.0, 4.0, 6.0));
        assert_eq!(a / 2.0, Vec3::new(0.5, 1.0, 1.5));
    }

    #[test]
    fn assign_operators() {
        let mut v = Vec3::new(1.0, 2.0, 3.0);
        v += Vec3::ONE;
        assert_eq!(v, Vec3::new(2.0, 3.0, 4.0));
        v -= Vec3::new(2.0, 2.0, 2.0);
        assert_eq!(v, Vec3::new(0.0, 1.0, 2.0));
        v *= 3.0;
        assert_eq!(v, Vec3::new(0.0, 3.0, 6.0));
        v /= 3.0;
        assert_eq!(v, Vec3::new(0.0, 1.0, 2.0));
    }

    #[test]
    fn indexing_by_axis() {
        let v = Vec3::new(7.0, 8.0, 9.0);
        assert_eq!((v[0], v[1], v[2]), (7.0, 8.0, 9.0));
    }

    #[test]
    #[should_panic(expected = "axis out of range")]
    fn indexing_past_z_panics() {
        let _ = Vec3::ZERO[3];
    }

    #[test]
    fn length_and_length_squared() {
        let v = Vec3::new(2.0, 3.0, 6.0);
        assert_eq!(v.length_squared(), 49.0);
        assert_eq!(v.length(), 7.0);
        assert_eq!(Vec3::ZERO.length(), 0.0);
    }

    #[test]
    fn dot_product() {
        let a = Vec3::new(1.0, 2.0, 3.0);
        let b = Vec3::new(4.0, -5.0, 6.0);
        assert_eq!(a.dot(b), 12.0);
        // Perpendicular vectors.
        assert_eq!(Vec3::new(1.0, 0.0, 0.0).dot(Vec3::new(0.0, 1.0, 0.0)), 0.0);
        // v . v == |v|^2
        assert_eq!(a.dot(a), a.length_squared());
    }

    #[test]
    fn cross_product() {
        let x = Vec3::new(1.0, 0.0, 0.0);
        let y = Vec3::new(0.0, 1.0, 0.0);
        let z = Vec3::new(0.0, 0.0, 1.0);
        assert_eq!(x.cross(y), z);
        assert_eq!(y.cross(z), x);
        assert_eq!(z.cross(x), y);
        assert_eq!(y.cross(x), -z);
        let a = Vec3::new(1.0, 2.0, 3.0);
        let b = Vec3::new(4.0, 5.0, 6.0);
        let c = a.cross(b);
        assert_eq!(c, Vec3::new(-3.0, 6.0, -3.0));
        // The cross product is perpendicular to both inputs.
        assert_eq!(c.dot(a), 0.0);
        assert_eq!(c.dot(b), 0.0);
        assert_eq!(a.cross(a), Vec3::ZERO);
    }

    #[test]
    fn unit_vector() {
        let u = Vec3::new(3.0, 0.0, 4.0).unit();
        assert!(close(u.x, 0.6) && close(u.y, 0.0) && close(u.z, 0.8));
        assert!(close(u.length(), 1.0));
        let w = Vec3::new(-1.0, 1.0, -1.0).unit();
        assert!(close(w.length(), 1.0));
        assert!(w.x < 0.0 && w.y > 0.0 && w.z < 0.0);
    }

    #[test]
    fn near_zero_checks() {
        assert!(Vec3::ZERO.near_zero());
        assert!(Vec3::new(1e-9, -1e-9, 5e-9).near_zero());
        assert!(!Vec3::new(1e-9, 1e-3, 0.0).near_zero());
        assert!(!Vec3::new(-1e-7, 0.0, 0.0).near_zero());
    }

    #[test]
    fn component_min_max() {
        let a = Vec3::new(1.0, 5.0, -2.0);
        let b = Vec3::new(3.0, -1.0, -4.0);
        assert_eq!(a.min(b), Vec3::new(1.0, -1.0, -4.0));
        assert_eq!(a.max(b), Vec3::new(3.0, 5.0, -2.0));
    }

    #[test]
    fn random_vectors_stay_in_range() {
        let mut rng = seeded(1);
        for _ in 0..1000 {
            let v = Vec3::random(&mut rng);
            for i in 0..3 {
                assert!((0.0..1.0).contains(&v[i]));
            }
            let w = Vec3::random_range(&mut rng, -2.0, 3.0);
            for i in 0..3 {
                assert!((-2.0..3.0).contains(&w[i]));
            }
        }
    }

    #[test]
    fn random_in_unit_sphere_is_inside() {
        let mut rng = seeded(2);
        let mut sum = Vec3::ZERO;
        for _ in 0..5000 {
            let p = random_in_unit_sphere(&mut rng);
            assert!(p.length_squared() < 1.0);
            sum += p;
        }
        // Uniform in a ball, so the average is near the center.
        assert!((sum / 5000.0).length() < 0.05);
    }

    #[test]
    fn random_unit_vector_has_length_one() {
        let mut rng = seeded(3);
        for _ in 0..1000 {
            assert!(close(random_unit_vector(&mut rng).length(), 1.0));
        }
    }

    #[test]
    fn random_in_unit_disk_is_flat_and_inside() {
        let mut rng = seeded(4);
        for _ in 0..1000 {
            let p = random_in_unit_disk(&mut rng);
            assert_eq!(p.z, 0.0);
            assert!(p.length_squared() < 1.0);
        }
    }
}
