//! Scene files: camera, render settings, named materials, objects, and an optional
//! field of random spheres, all in TOML.
//!
//! ```toml
//! [camera]
//! look_from = [13, 2, 3]
//! look_at = [0, 0, 0]
//! vfov = 20
//!
//! [materials.glass]
//! type = "dielectric"
//! ior = 1.5
//!
//! [[objects]]
//! type = "sphere"
//! center = [0, 1, 0]
//! radius = 1
//! material = "glass"
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use rand::Rng as _;
use serde::Deserialize;

use crate::bvh::Bvh;
use crate::camera::CameraConfig;
use crate::hittable::{Hittable, HittableList};
use crate::material::Material;
use crate::render::RenderSettings;
use crate::rng;
use crate::sphere::Sphere;
use crate::vec3::{Color, Vec3};

/// Why a scene couldn't be loaded.
#[derive(Debug)]
pub enum SceneError {
    /// The file couldn't be read.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// Not valid TOML, or a field is missing or has the wrong type.
    Parse(String),
    /// Well-formed, but the values don't make sense (unknown material, bad radius...).
    Invalid(String),
}

impl fmt::Display for SceneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SceneError::Io { path, source } => {
                write!(f, "could not read {}: {source}", path.display())
            }
            SceneError::Parse(msg) => write!(f, "invalid scene file: {msg}"),
            SceneError::Invalid(msg) => write!(f, "invalid scene: {msg}"),
        }
    }
}

impl std::error::Error for SceneError {}

// ---- The file format, as serde sees it ----

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneFile {
    camera: CameraSpec,
    #[serde(default)]
    render: RenderSpec,
    #[serde(default)]
    materials: BTreeMap<String, MaterialSpec>,
    #[serde(default)]
    objects: Vec<ObjectSpec>,
    random_field: Option<RandomField>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CameraSpec {
    look_from: [f64; 3],
    look_at: [f64; 3],
    #[serde(default = "default_vup")]
    vup: [f64; 3],
    vfov: f64,
    #[serde(default = "default_aspect_ratio")]
    aspect_ratio: f64,
    #[serde(default)]
    aperture: f64,
    /// Defaults to the distance from `look_from` to `look_at`.
    focus_dist: Option<f64>,
}

fn default_vup() -> [f64; 3] {
    [0.0, 1.0, 0.0]
}

fn default_aspect_ratio() -> f64 {
    16.0 / 9.0
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RenderSpec {
    width: u32,
    samples_per_pixel: u32,
    max_depth: u32,
    seed: u64,
}

impl Default for RenderSpec {
    fn default() -> Self {
        let s = RenderSettings::default();
        RenderSpec {
            width: 400,
            samples_per_pixel: s.samples_per_pixel,
            max_depth: s.max_depth,
            seed: s.seed,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum MaterialSpec {
    Lambertian {
        albedo: [f64; 3],
    },
    Metal {
        albedo: [f64; 3],
        #[serde(default)]
        fuzz: f64,
    },
    Dielectric {
        ior: f64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum ObjectSpec {
    Sphere {
        center: [f64; 3],
        radius: f64,
        material: String,
    },
}

/// The classic grid of small random spheres on the ground.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RandomField {
    /// Layout seed. When absent, the render seed is used, so `--seed` changes it.
    pub seed: Option<u64>,
    /// Grid cells run from `-extent` to `extent - 1` on x and z.
    pub extent: i32,
    /// Radius of every small sphere; they rest on y = 0.
    pub radius: f64,
}

impl Default for RandomField {
    fn default() -> Self {
        RandomField {
            seed: None,
            extent: 11,
            radius: 0.2,
        }
    }
}

// ---- The loaded scene ----

/// A scene ready to render.
#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    pub camera: CameraConfig,
    /// Image width in pixels; the height comes from the camera's aspect ratio.
    pub width: u32,
    pub settings: RenderSettings,
    /// Hand-placed spheres.
    pub spheres: Vec<Sphere>,
    pub random_field: Option<RandomField>,
}

impl Scene {
    /// Read and parse a scene file.
    pub fn load(path: &Path) -> Result<Scene, SceneError> {
        let text = std::fs::read_to_string(path).map_err(|source| SceneError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Scene::parse(&text)
    }

    /// Parse scene TOML.
    pub fn parse(text: &str) -> Result<Scene, SceneError> {
        let file: SceneFile =
            toml::from_str(text).map_err(|e| SceneError::Parse(e.to_string().trim().into()))?;
        let invalid = |msg: String| Err(SceneError::Invalid(msg));

        // Camera.
        let c = &file.camera;
        let look_from = vec3(c.look_from);
        let look_at = vec3(c.look_at);
        let camera = CameraConfig {
            look_from,
            look_at,
            vup: vec3(c.vup),
            vfov: c.vfov,
            aspect_ratio: c.aspect_ratio,
            aperture: c.aperture,
            focus_dist: c.focus_dist.unwrap_or((look_from - look_at).length()),
        };
        if let Err(e) = camera.validate() {
            return invalid(format!("camera: {e}"));
        }

        // Render settings.
        let r = &file.render;
        for (name, value) in [
            ("width", r.width),
            ("samples_per_pixel", r.samples_per_pixel),
            ("max_depth", r.max_depth),
        ] {
            if value == 0 {
                return invalid(format!("render.{name} must be at least 1"));
            }
        }

        // Materials.
        let mut materials = BTreeMap::new();
        for (name, spec) in &file.materials {
            let material = build_material(spec)
                .map_err(|e| SceneError::Invalid(format!("material \"{name}\": {e}")))?;
            materials.insert(name.as_str(), material);
        }

        // Objects.
        let mut spheres = Vec::with_capacity(file.objects.len());
        for (i, object) in file.objects.iter().enumerate() {
            let ObjectSpec::Sphere {
                center,
                radius,
                material,
            } = object;
            let Some(&mat) = materials.get(material.as_str()) else {
                let known: Vec<&str> = materials.keys().copied().collect();
                return invalid(format!(
                    "object {} uses unknown material \"{material}\" (defined: {})",
                    i + 1,
                    if known.is_empty() {
                        "none".to_string()
                    } else {
                        known.join(", ")
                    }
                ));
            };
            if !(*radius > 0.0 && radius.is_finite()) {
                return invalid(format!(
                    "object {} radius must be positive, got {radius}",
                    i + 1
                ));
            }
            if center.iter().any(|v| !v.is_finite()) {
                return invalid(format!("object {} center must be finite", i + 1));
            }
            spheres.push(Sphere::new(vec3(*center), *radius, mat));
        }

        if let Some(field) = &file.random_field {
            if field.extent < 0 {
                return invalid("random_field.extent must be 0 or more".into());
            }
            if !(field.radius > 0.0 && field.radius.is_finite()) {
                return invalid("random_field.radius must be positive".into());
            }
        }

        Ok(Scene {
            camera,
            width: r.width,
            settings: RenderSettings {
                samples_per_pixel: r.samples_per_pixel,
                max_depth: r.max_depth,
                seed: r.seed,
            },
            spheres,
            random_field: file.random_field,
        })
    }

    /// Every sphere: the hand-placed ones plus the random field (if any), whose
    /// layout comes from its own seed or else the render seed.
    pub fn objects(&self) -> Vec<Sphere> {
        let mut all = self.spheres.clone();
        if let Some(field) = &self.random_field {
            let seed = field.seed.unwrap_or(self.settings.seed);
            all.extend(random_field(field, seed, &self.spheres));
        }
        all
    }

    /// The world to render: a BVH over all objects, or a plain list to compare.
    pub fn world(&self, use_bvh: bool) -> Box<dyn Hittable> {
        let objects: Vec<Box<dyn Hittable>> = self
            .objects()
            .into_iter()
            .map(|s| Box::new(s) as Box<dyn Hittable>)
            .collect();
        if use_bvh {
            Box::new(Bvh::new(objects))
        } else {
            Box::new(HittableList { objects })
        }
    }
}

fn vec3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0], a[1], a[2])
}

fn color(name: &str, a: [f64; 3]) -> Result<Color, String> {
    if a.iter().all(|c| c.is_finite() && *c >= 0.0) {
        Ok(vec3(a))
    } else {
        Err(format!("{name} components must be 0 or more"))
    }
}

fn build_material(spec: &MaterialSpec) -> Result<Material, String> {
    match *spec {
        MaterialSpec::Lambertian { albedo } => Ok(Material::lambertian(color("albedo", albedo)?)),
        MaterialSpec::Metal { albedo, fuzz } => {
            if !(0.0..=1.0).contains(&fuzz) {
                return Err(format!("fuzz must be between 0 and 1, got {fuzz}"));
            }
            Ok(Material::metal(color("albedo", albedo)?, fuzz))
        }
        MaterialSpec::Dielectric { ior } => {
            if !(ior > 0.0 && ior.is_finite()) {
                return Err(format!("ior must be positive, got {ior}"));
            }
            Ok(Material::dielectric(ior))
        }
    }
}

/// One small sphere per grid cell, jittered inside the cell: 80% diffuse,
/// 15% metal, 5% glass. Cells whose sphere would cut into an existing sphere
/// are left empty.
pub fn random_field(field: &RandomField, seed: u64, existing: &[Sphere]) -> Vec<Sphere> {
    let mut rng = rng::stream(seed, u64::MAX);
    let r = field.radius;
    let mut spheres = Vec::new();
    for a in -field.extent..field.extent {
        for b in -field.extent..field.extent {
            let choose: f64 = rng.random();
            let center = Vec3::new(
                a as f64 + 0.9 * rng.random::<f64>(),
                r,
                b as f64 + 0.9 * rng.random::<f64>(),
            );
            let material = if choose < 0.8 {
                Material::lambertian(Vec3::random(&mut rng) * Vec3::random(&mut rng))
            } else if choose < 0.95 {
                Material::metal(
                    Vec3::random_range(&mut rng, 0.5, 1.0),
                    rng.random_range(0.0..0.5),
                )
            } else {
                Material::dielectric(1.5)
            };
            let overlaps = existing
                .iter()
                .any(|s| (center - s.center).length() < s.radius + r);
            if !overlaps {
                spheres.push(Sphere::new(center, r, material));
            }
        }
    }
    spheres
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
        [camera]
        look_from = [0, 0, 5]
        look_at = [0, 0, 0]
        vfov = 40
    "#;

    fn err(text: &str) -> String {
        Scene::parse(text).unwrap_err().to_string()
    }

    #[test]
    fn minimal_scene_uses_defaults() {
        let scene = Scene::parse(MINIMAL).unwrap();
        assert_eq!(scene.camera.vup, Vec3::new(0.0, 1.0, 0.0));
        assert_eq!(scene.camera.aspect_ratio, 16.0 / 9.0);
        assert_eq!(scene.camera.aperture, 0.0);
        assert_eq!(scene.camera.focus_dist, 5.0);
        assert_eq!(scene.width, 400);
        assert_eq!(scene.settings, RenderSettings::default());
        assert!(scene.spheres.is_empty());
        assert!(scene.random_field.is_none());
        assert!(scene.objects().is_empty());
    }

    #[test]
    fn full_scene_loads_every_field() {
        let scene = Scene::parse(
            r#"
            [camera]
            look_from = [1, 2, 3]
            look_at = [0, 0, -1]
            vup = [0, 0, 1]
            vfov = 30.5
            aspect_ratio = 2.0
            aperture = 0.2
            focus_dist = 4

            [render]
            width = 64
            samples_per_pixel = 8
            max_depth = 12
            seed = 99

            [materials.matte]
            type = "lambertian"
            albedo = [0.1, 0.2, 0.3]

            [materials.mirror]
            type = "metal"
            albedo = [0.9, 0.9, 0.9]

            [materials.rough]
            type = "metal"
            albedo = [0.5, 0.5, 0.5]
            fuzz = 0.4

            [materials.glass]
            type = "dielectric"
            ior = 1.5

            [[objects]]
            type = "sphere"
            center = [0, -100, 0]
            radius = 100
            material = "matte"

            [[objects]]
            type = "sphere"
            center = [1.5, 0.5, 0]
            radius = 0.5
            material = "glass"

            [[objects]]
            type = "sphere"
            center = [-1.5, 0.5, 0]
            radius = 0.5
            material = "mirror"

            [random_field]
            seed = 3
            extent = 2
            radius = 0.1
            "#,
        )
        .unwrap();
        assert_eq!(scene.camera.look_from, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(scene.camera.vup, Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(scene.camera.vfov, 30.5);
        assert_eq!(scene.camera.aspect_ratio, 2.0);
        assert_eq!(scene.camera.aperture, 0.2);
        assert_eq!(scene.camera.focus_dist, 4.0);
        assert_eq!(scene.width, 64);
        assert_eq!(
            scene.settings,
            RenderSettings {
                samples_per_pixel: 8,
                max_depth: 12,
                seed: 99
            }
        );
        assert_eq!(scene.spheres.len(), 3);
        assert_eq!(
            scene.spheres[0].material,
            Material::lambertian(Color::new(0.1, 0.2, 0.3))
        );
        assert_eq!(scene.spheres[1].material, Material::dielectric(1.5));
        assert_eq!(
            scene.spheres[2].material,
            Material::metal(Color::new(0.9, 0.9, 0.9), 0.0)
        );
        assert_eq!(
            scene.random_field,
            Some(RandomField {
                seed: Some(3),
                extent: 2,
                radius: 0.1
            })
        );
        // 16 grid cells, minus any that would cut into the three spheres.
        let n = scene.objects().len();
        assert!(n > 3 + 10 && n <= 3 + 16, "{n}");
    }

    #[test]
    fn missing_fields_are_named() {
        let no_vfov = MINIMAL.replace("vfov = 40", "");
        assert!(
            err(&no_vfov).contains("missing field `vfov`"),
            "{}",
            err(&no_vfov)
        );

        let no_camera = "[render]\nwidth = 10\n";
        assert!(err(no_camera).contains("missing field `camera`"));

        let no_albedo = format!("{MINIMAL}\n[materials.red]\ntype = \"lambertian\"\n");
        assert!(
            err(&no_albedo).contains("missing field `albedo`"),
            "{}",
            err(&no_albedo)
        );

        let no_radius = format!(
            "{MINIMAL}\n[materials.m]\ntype = \"dielectric\"\nior = 1.5\n\
             [[objects]]\ntype = \"sphere\"\ncenter = [0, 0, 0]\nmaterial = \"m\"\n"
        );
        assert!(err(&no_radius).contains("missing field `radius`"));

        let no_type = format!("{MINIMAL}\n[materials.m]\nior = 1.5\n");
        assert!(
            err(&no_type).contains("missing field `type`"),
            "{}",
            err(&no_type)
        );
    }

    #[test]
    fn errors_point_at_the_line() {
        let no_albedo = format!("{MINIMAL}\n[materials.red]\ntype = \"lambertian\"\n");
        // MINIMAL is 6 lines (starting with an empty one), so the table is on line 7.
        assert!(err(&no_albedo).contains("line 7"), "{}", err(&no_albedo));
    }

    #[test]
    fn unknown_material_type_lists_the_options() {
        let plastic =
            format!("{MINIMAL}\n[materials.toy]\ntype = \"plastic\"\nalbedo = [1, 0, 0]\n");
        let msg = err(&plastic);
        assert!(msg.contains("unknown variant `plastic`"), "{msg}");
        assert!(msg.contains("lambertian") && msg.contains("metal") && msg.contains("dielectric"));
    }

    #[test]
    fn unknown_material_name_lists_the_defined_ones() {
        let text = format!(
            "{MINIMAL}\n[materials.glass]\ntype = \"dielectric\"\nior = 1.5\n\
             [materials.chrome]\ntype = \"metal\"\nalbedo = [0.8, 0.8, 0.8]\n\
             [[objects]]\ntype = \"sphere\"\ncenter = [0, 0, 0]\nradius = 1\nmaterial = \"gold\"\n"
        );
        assert_eq!(
            err(&text),
            "invalid scene: object 1 uses unknown material \"gold\" (defined: chrome, glass)"
        );
        let none = format!(
            "{MINIMAL}\n[[objects]]\ntype = \"sphere\"\ncenter = [0, 0, 0]\nradius = 1\nmaterial = \"x\"\n"
        );
        assert!(err(&none).contains("(defined: none)"));
    }

    #[test]
    fn unknown_fields_and_object_types_are_rejected() {
        let typo = MINIMAL.replace("vfov", "fov");
        assert!(err(&typo).contains("unknown field `fov`"), "{}", err(&typo));
        let cube = format!("{MINIMAL}\n[[objects]]\ntype = \"cube\"\n");
        assert!(err(&cube).contains("unknown variant `cube`"));
        let extra =
            format!("{MINIMAL}\n[materials.m]\ntype = \"dielectric\"\nior = 1.5\ncolor = 1\n");
        assert!(err(&extra).contains("unknown field `color`"));
    }

    #[test]
    fn wrong_types_and_bad_toml() {
        let text = MINIMAL.replace("vfov = 40", "vfov = \"wide\"");
        assert!(err(&text).starts_with("invalid scene file:"));
        let short = MINIMAL.replace("[0, 0, 5]", "[0, 5]");
        assert!(err(&short).starts_with("invalid scene file:"));
        assert!(err("this is not toml").starts_with("invalid scene file:"));
    }

    #[test]
    fn bad_values_are_rejected() {
        let cases = [
            (MINIMAL.replace("vfov = 40", "vfov = 200"), "camera: vfov"),
            (
                MINIMAL.replace("[0, 0, 5]", "[0, 0, 0]"),
                "camera: look_from and look_at",
            ),
            (
                format!("{MINIMAL}\n[render]\nwidth = 0\n"),
                "render.width must be at least 1",
            ),
            (
                format!("{MINIMAL}\n[render]\nsamples_per_pixel = 0\n"),
                "render.samples_per_pixel",
            ),
            (
                format!("{MINIMAL}\n[render]\nmax_depth = 0\n"),
                "render.max_depth",
            ),
            (
                format!(
                    "{MINIMAL}\n[materials.m]\ntype = \"metal\"\nalbedo = [1, 1, 1]\nfuzz = 2\n"
                ),
                "material \"m\": fuzz must be between 0 and 1",
            ),
            (
                format!("{MINIMAL}\n[materials.m]\ntype = \"dielectric\"\nior = 0\n"),
                "material \"m\": ior must be positive",
            ),
            (
                format!("{MINIMAL}\n[materials.m]\ntype = \"lambertian\"\nalbedo = [1, -1, 1]\n"),
                "albedo components must be 0 or more",
            ),
            (
                format!(
                    "{MINIMAL}\n[materials.m]\ntype = \"dielectric\"\nior = 1.5\n\
                     [[objects]]\ntype = \"sphere\"\ncenter = [0, 0, 0]\nradius = -1\nmaterial = \"m\"\n"
                ),
                "object 1 radius must be positive",
            ),
            (
                format!(
                    "{MINIMAL}\n[materials.m]\ntype = \"dielectric\"\nior = 1.5\n\
                     [[objects]]\ntype = \"sphere\"\ncenter = [0, nan, 0]\nradius = 1\nmaterial = \"m\"\n"
                ),
                "object 1 center must be finite",
            ),
            (
                format!("{MINIMAL}\n[random_field]\nextent = -1\n"),
                "random_field.extent",
            ),
            (
                format!("{MINIMAL}\n[random_field]\nradius = 0\n"),
                "random_field.radius",
            ),
        ];
        for (text, expected) in cases {
            let msg = err(&text);
            assert!(msg.starts_with("invalid scene: "), "{msg}");
            assert!(msg.contains(expected), "expected {expected:?} in {msg:?}");
        }
    }

    #[test]
    fn load_reports_missing_files() {
        let e = Scene::load(Path::new("no/such/scene.toml")).unwrap_err();
        assert!(matches!(e, SceneError::Io { .. }));
        assert!(
            e.to_string()
                .starts_with("could not read no/such/scene.toml")
        );
    }

    fn field_scene(seed_line: &str) -> Scene {
        Scene::parse(&format!(
            "{MINIMAL}\n[render]\nseed = 5\n\
             [materials.ground]\ntype = \"lambertian\"\nalbedo = [0.5, 0.5, 0.5]\n\
             [[objects]]\ntype = \"sphere\"\ncenter = [0, -1000, 0]\nradius = 1000\nmaterial = \"ground\"\n\
             [[objects]]\ntype = \"sphere\"\ncenter = [0, 1, 0]\nradius = 1\nmaterial = \"ground\"\n\
             [random_field]\n{seed_line}\n"
        ))
        .unwrap()
    }

    #[test]
    fn random_field_is_seeded() {
        let scene = field_scene("");
        let a = scene.objects();
        assert_eq!(a, scene.objects());
        // No seed in the field: the render seed decides the layout.
        let mut reseeded = scene.clone();
        reseeded.settings.seed = 6;
        assert_ne!(reseeded.objects(), a);
        // With its own seed, the render seed doesn't matter.
        let fixed = field_scene("seed = 5");
        let mut fixed2 = fixed.clone();
        fixed2.settings.seed = 6;
        assert_eq!(fixed.objects(), fixed2.objects());
        assert_eq!(fixed.objects(), a);
    }

    #[test]
    fn random_field_avoids_existing_spheres_but_rests_on_the_ground() {
        let scene = field_scene("");
        let objects = scene.objects();
        let small = &objects[2..];
        // 22 x 22 cells, a few skipped around the big sphere at the origin.
        assert!(small.len() > 470 && small.len() < 484, "{}", small.len());
        let big = scene.spheres[1];
        for s in small {
            assert_eq!(s.radius, 0.2);
            assert_eq!(s.center.y, 0.2);
            assert!((s.center - big.center).length() >= big.radius + 0.2);
        }
        let glass = small
            .iter()
            .filter(|s| matches!(s.material, Material::Dielectric { .. }))
            .count();
        let metal = small
            .iter()
            .filter(|s| matches!(s.material, Material::Metal { .. }))
            .count();
        // Roughly 5% glass, 15% metal.
        assert!((10..=45).contains(&glass), "{glass}");
        assert!((40..=110).contains(&metal), "{metal}");
    }

    #[test]
    fn world_with_and_without_bvh_agree() {
        let scene = field_scene("");
        let bvh = scene.world(true);
        let list = scene.world(false);
        assert_eq!(bvh.bounding_box(), list.bounding_box());
        let mut rng = rng::seeded(1);
        for _ in 0..500 {
            let origin = Vec3::new(0.0, 1.0, 10.0) + Vec3::random_range(&mut rng, -1.0, 1.0);
            let target = Vec3::random_range(&mut rng, -10.0, 10.0);
            let ray = crate::ray::Ray::new(origin, target - origin);
            assert_eq!(
                bvh.hit(&ray, 0.001, f64::INFINITY),
                list.hit(&ray, 0.001, f64::INFINITY)
            );
        }
    }
}
