//! How surfaces scatter light: diffuse, metal and glass.

use rand::Rng as _;

use crate::hittable::HitRecord;
use crate::ray::Ray;
use crate::rng::Rng;
use crate::vec3::{Color, Vec3, random_unit_vector};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Material {
    /// Matte: scatters in random directions, favoring the normal (cosine weighted).
    Lambertian { albedo: Color },
    /// Mirror-like: reflects about the normal, blurred by `fuzz` (0 = perfect mirror).
    Metal { albedo: Color, fuzz: f64 },
    /// Clear glass, water, diamond: refracts or reflects, absorbs nothing.
    /// `ior` is the index of refraction (glass ~1.5, water ~1.33, diamond ~2.4).
    Dielectric { ior: f64 },
}

/// A scattered ray and how much it tints the light it carries.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scatter {
    pub attenuation: Color,
    pub ray: Ray,
}

impl Material {
    pub fn lambertian(albedo: Color) -> Self {
        Material::Lambertian { albedo }
    }

    /// Fuzz is clamped to `[0, 1]`; more than that would scatter rays into the surface.
    pub fn metal(albedo: Color, fuzz: f64) -> Self {
        Material::Metal {
            albedo,
            fuzz: fuzz.clamp(0.0, 1.0),
        }
    }

    pub fn dielectric(ior: f64) -> Self {
        Material::Dielectric { ior }
    }

    /// Where the light goes after hitting this surface, or `None` if it is absorbed.
    pub fn scatter(&self, ray_in: &Ray, rec: &HitRecord, rng: &mut Rng) -> Option<Scatter> {
        match *self {
            Material::Lambertian { albedo } => {
                let direction = lambertian_direction(rec.normal, random_unit_vector(rng));
                Some(Scatter {
                    attenuation: albedo,
                    ray: Ray::new(rec.point, direction),
                })
            }
            Material::Metal { albedo, fuzz } => {
                let reflected = reflect(ray_in.direction, rec.normal).unit();
                let direction = reflected + fuzz * random_unit_vector(rng);
                // Fuzz can push the ray below the surface; treat that as absorbed.
                (direction.dot(rec.normal) > 0.0).then_some(Scatter {
                    attenuation: albedo,
                    ray: Ray::new(rec.point, direction),
                })
            }
            Material::Dielectric { ior } => {
                // Entering the glass: air/glass. Leaving it: glass/air.
                let eta_ratio = if rec.front_face { 1.0 / ior } else { ior };
                let unit = ray_in.direction.unit();
                let cos_theta = (-unit).dot(rec.normal).min(1.0);

                let direction = if must_reflect(cos_theta, eta_ratio)
                    || reflectance(cos_theta, eta_ratio) > rng.random::<f64>()
                {
                    reflect(unit, rec.normal)
                } else {
                    refract(unit, rec.normal, eta_ratio)
                };
                Some(Scatter {
                    attenuation: Color::ONE,
                    ray: Ray::new(rec.point, direction),
                })
            }
        }
    }
}

/// Normal plus a random unit vector gives a cosine-weighted direction. If the two
/// nearly cancel, the result is ~zero and would make a degenerate ray, so fall back
/// to the normal.
pub fn lambertian_direction(normal: Vec3, random_unit: Vec3) -> Vec3 {
    let direction = normal + random_unit;
    if direction.near_zero() {
        normal
    } else {
        direction
    }
}

/// Mirror `v` about the surface with normal `n` (unit length).
pub fn reflect(v: Vec3, n: Vec3) -> Vec3 {
    v - 2.0 * v.dot(n) * n
}

/// Bend the unit vector `uv` through a surface with unit normal `n` (facing `uv`'s
/// side), by Snell's law `sin(theta') = eta_ratio * sin(theta)`, where
/// `eta_ratio = n_from / n_to`. The result is split into the part perpendicular to the
/// normal, which scales by `eta_ratio`, and the part along it, which fills the rest
/// of a unit vector.
pub fn refract(uv: Vec3, n: Vec3, eta_ratio: f64) -> Vec3 {
    let cos_theta = (-uv).dot(n).min(1.0);
    let r_perp = eta_ratio * (uv + cos_theta * n);
    let r_parallel = -(1.0 - r_perp.length_squared()).abs().sqrt() * n;
    r_perp + r_parallel
}

/// Total internal reflection: Snell's law has no solution when `eta_ratio * sin > 1`,
/// so all the light reflects. Only possible going from dense to thin (glass to air).
pub fn must_reflect(cos_theta: f64, eta_ratio: f64) -> bool {
    let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
    eta_ratio * sin_theta > 1.0
}

/// Schlick's approximation of how much light glass reflects at a given angle:
/// about 4% head on, rising to 100% at grazing angles.
pub fn reflectance(cos_theta: f64, eta_ratio: f64) -> f64 {
    let r0 = ((1.0 - eta_ratio) / (1.0 + eta_ratio)).powi(2);
    r0 + (1.0 - r0) * (1.0 - cos_theta).powi(5)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::seeded;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn close_vec(a: Vec3, b: Vec3) -> bool {
        (a - b).length() < 1e-9
    }

    const UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);

    /// A hit on the plane y = 0 at the origin, from a ray coming in along `dir`.
    fn hit_with(dir: Vec3, outward_normal: Vec3, material: Material) -> (Ray, HitRecord) {
        let ray = Ray::new(-dir, dir);
        let rec = HitRecord::new(&ray, 1.0, outward_normal, material);
        (ray, rec)
    }

    #[test]
    fn reflect_matches_hand_computed_values() {
        // 45 degrees down onto a floor bounces 45 degrees up.
        assert_eq!(
            reflect(Vec3::new(1.0, -1.0, 0.0), UP),
            Vec3::new(1.0, 1.0, 0.0)
        );
        // Only the component along the normal flips.
        assert_eq!(
            reflect(Vec3::new(1.0, -2.0, 3.0), UP),
            Vec3::new(1.0, 2.0, 3.0)
        );
        // Straight down bounces straight back.
        assert_eq!(reflect(Vec3::new(0.0, -1.0, 0.0), UP), UP);
        // A tilted normal: (1,0,0) off a 45-degree mirror goes to (0,1,0).
        let n = Vec3::new(-1.0, 1.0, 0.0).unit();
        assert!(close_vec(
            reflect(Vec3::new(1.0, 0.0, 0.0), n),
            Vec3::new(0.0, 1.0, 0.0)
        ));
    }

    #[test]
    fn refract_matches_hand_computed_values() {
        // Air into glass at 45 degrees: sin(theta') = sin(45) / 1.5 = 0.471405,
        // cos(theta') = sqrt(1 - 0.222222) = 0.881917.
        let uv = Vec3::new(1.0, -1.0, 0.0).unit();
        let r = refract(uv, UP, 1.0 / 1.5);
        assert!(
            close_vec(r, Vec3::new(0.471_404_520_8, -0.881_917_103_7, 0.0)),
            "{r:?}"
        );
        assert!(close(r.length(), 1.0));
        // The ray bends toward the normal going into the denser medium.
        assert!(r.x < uv.x);
    }

    #[test]
    fn refract_head_on_goes_straight_through() {
        let r = refract(Vec3::new(0.0, -1.0, 0.0), UP, 1.0 / 1.5);
        assert!(close_vec(r, Vec3::new(0.0, -1.0, 0.0)));
    }

    #[test]
    fn refract_with_equal_indices_does_not_bend() {
        let uv = Vec3::new(0.3, -0.8, 0.2).unit();
        assert!(close_vec(refract(uv, UP, 1.0), uv));
    }

    #[test]
    fn refract_out_of_glass_bends_away_from_normal() {
        // Glass to air at 30 degrees: sin(theta') = 1.5 * 0.5 = 0.75.
        let uv = Vec3::new(0.5, -(0.75f64).sqrt(), 0.0);
        let r = refract(uv, UP, 1.5);
        assert!(close(r.x, 0.75));
        assert!(close(r.y, -(1.0 - 0.5625f64).sqrt()));
    }

    #[test]
    fn total_internal_reflection_triggers_at_the_critical_angle() {
        // Glass to air: critical angle = asin(1 / 1.5) = 41.81 degrees.
        let critical = (1.0f64 / 1.5).asin().to_degrees();
        assert!(close(critical, 41.810_314_895_778_6));
        let at = |deg: f64| must_reflect(deg.to_radians().cos(), 1.5);
        assert!(!at(0.0));
        assert!(!at(41.0));
        assert!(!at(critical - 0.01));
        assert!(at(critical + 0.01));
        assert!(at(42.0));
        assert!(at(89.0));
        // Air to glass never totally reflects, even at grazing angles.
        assert!(!must_reflect(0.0, 1.0 / 1.5));
    }

    #[test]
    fn schlick_at_normal_and_grazing_angles() {
        // Head on: r0 = ((1 - 1.5) / (1 + 1.5))^2 = 0.04, either direction.
        assert!(close(reflectance(1.0, 1.0 / 1.5), 0.04));
        assert!(close(reflectance(1.0, 1.5), 0.04));
        // Grazing: everything reflects.
        assert!(close(reflectance(0.0, 1.0 / 1.5), 1.0));
        // In between it rises monotonically.
        let mid = reflectance(0.5, 1.0 / 1.5);
        assert!(close(mid, 0.04 + 0.96 * 0.5f64.powi(5)));
        assert!(reflectance(0.9, 1.0 / 1.5) < mid && mid < reflectance(0.1, 1.0 / 1.5));
        // Equal indices: nothing reflects head on.
        assert!(close(reflectance(1.0, 1.0), 0.0));
    }

    #[test]
    fn lambertian_scatters_above_the_surface_with_its_albedo() {
        let albedo = Color::new(0.8, 0.3, 0.1);
        let (ray, rec) = hit_with(Vec3::new(0.3, -1.0, 0.0), UP, Material::lambertian(albedo));
        let mut rng = seeded(1);
        for _ in 0..500 {
            let s = rec.material.scatter(&ray, &rec, &mut rng).unwrap();
            assert_eq!(s.attenuation, albedo);
            assert_eq!(s.ray.origin, rec.point);
            assert!(s.ray.direction.dot(UP) >= 0.0);
        }
    }

    #[test]
    fn lambertian_falls_back_to_the_normal_for_degenerate_directions() {
        assert_eq!(lambertian_direction(UP, -UP), UP);
        let r = Vec3::new(1.0, 0.0, 0.0);
        assert_eq!(lambertian_direction(UP, r), UP + r);
    }

    #[test]
    fn polished_metal_is_a_perfect_mirror() {
        let albedo = Color::new(0.9, 0.9, 0.9);
        let (ray, rec) = hit_with(Vec3::new(1.0, -1.0, 0.0), UP, Material::metal(albedo, 0.0));
        let s = rec.material.scatter(&ray, &rec, &mut seeded(1)).unwrap();
        assert_eq!(s.attenuation, albedo);
        assert!(close_vec(s.ray.direction, Vec3::new(1.0, 1.0, 0.0).unit()));
    }

    #[test]
    fn metal_fuzz_is_clamped() {
        assert_eq!(
            Material::metal(Color::ONE, 3.0),
            Material::Metal {
                albedo: Color::ONE,
                fuzz: 1.0
            }
        );
        assert_eq!(
            Material::metal(Color::ONE, -1.0),
            Material::Metal {
                albedo: Color::ONE,
                fuzz: 0.0
            }
        );
    }

    #[test]
    fn fuzzy_metal_absorbs_rays_scattered_into_the_surface() {
        // Nearly grazing, so the fuzz often pushes the reflection below the surface.
        let (ray, rec) = hit_with(
            Vec3::new(1.0, -0.05, 0.0),
            UP,
            Material::metal(Color::ONE, 1.0),
        );
        let mut rng = seeded(2);
        let results: Vec<_> = (0..1000)
            .map(|_| rec.material.scatter(&ray, &rec, &mut rng))
            .collect();
        assert!(results.iter().any(|s| s.is_none()));
        assert!(
            results
                .iter()
                .flatten()
                .all(|s| s.ray.direction.dot(UP) > 0.0)
        );
    }

    #[test]
    fn glass_mostly_refracts_head_on() {
        // Schlick says 4% reflect head on, so about 40 of 1000 rays bounce back.
        let (ray, rec) = hit_with(Vec3::new(0.0, -1.0, 0.0), UP, Material::dielectric(1.5));
        let mut rng = seeded(3);
        let mut reflected = 0;
        for _ in 0..1000 {
            let s = rec.material.scatter(&ray, &rec, &mut rng).unwrap();
            assert_eq!(s.attenuation, Color::ONE);
            if s.ray.direction.y > 0.0 {
                reflected += 1;
            } else {
                assert!(close_vec(s.ray.direction, Vec3::new(0.0, -1.0, 0.0)));
            }
        }
        assert!((20..=65).contains(&reflected), "{reflected}");
    }

    #[test]
    fn glass_reflects_everything_past_the_critical_angle_from_inside() {
        // Inside the glass, heading up toward the surface at 50 degrees from its normal.
        // The outward normal points up, so this is a back-face hit.
        let dir = Vec3::new(50f64.to_radians().sin(), 50f64.to_radians().cos(), 0.0);
        let (ray, rec) = hit_with(dir, UP, Material::dielectric(1.5));
        assert!(!rec.front_face);
        let mut rng = seeded(4);
        for _ in 0..200 {
            let s = rec.material.scatter(&ray, &rec, &mut rng).unwrap();
            // Reflected back down into the glass.
            assert!(close_vec(s.ray.direction, Vec3::new(dir.x, -dir.y, 0.0)));
        }
    }

    #[test]
    fn glass_lets_light_out_below_the_critical_angle() {
        // From inside at 20 degrees: mostly refracts out, bending away from the normal.
        let dir = Vec3::new(20f64.to_radians().sin(), 20f64.to_radians().cos(), 0.0);
        let (ray, rec) = hit_with(dir, UP, Material::dielectric(1.5));
        let mut rng = seeded(5);
        let escaped = (0..200)
            .map(|_| rec.material.scatter(&ray, &rec, &mut rng).unwrap())
            .filter(|s| s.ray.direction.y > 0.0)
            .inspect(|s| assert!(close(s.ray.direction.x, 1.5 * dir.x)))
            .count();
        assert!(escaped > 180, "{escaped}");
    }
}
