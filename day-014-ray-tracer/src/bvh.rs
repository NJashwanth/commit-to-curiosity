//! Axis-aligned bounding boxes and a bounding volume hierarchy.
//!
//! Testing a ray against every sphere costs O(n). A BVH wraps groups of objects in
//! boxes, and boxes in bigger boxes. If a ray misses a box it can skip everything
//! inside it, so a typical ray only looks at O(log n) objects.

use crate::hittable::{HitRecord, Hittable};
use crate::ray::Ray;
use crate::vec3::{Point3, Vec3};

/// An axis-aligned bounding box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb {
    pub min: Point3,
    pub max: Point3,
}

impl Aabb {
    /// Contains nothing. Surrounding it with another box gives that box.
    pub const EMPTY: Aabb = Aabb {
        min: Vec3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
        max: Vec3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
    };

    /// The box with corners `a` and `b`, in either order.
    pub fn new(a: Point3, b: Point3) -> Self {
        Aabb {
            min: a.min(b),
            max: a.max(b),
        }
    }

    /// The smallest box containing both.
    pub fn surrounding(self, other: Aabb) -> Aabb {
        Aabb {
            min: self.min.min(other.min),
            max: self.max.max(other.max),
        }
    }

    pub fn centroid(&self) -> Point3 {
        0.5 * (self.min + self.max)
    }

    /// 0, 1 or 2 for x, y or z: the axis the box is widest along.
    pub fn longest_axis(&self) -> usize {
        let size = self.max - self.min;
        if size.x >= size.y && size.x >= size.z {
            0
        } else if size.y >= size.z {
            1
        } else {
            2
        }
    }

    /// The slab test. On each axis the box is the slab between two planes, and the
    /// ray is inside that slab for some interval of t. The ray hits the box if the
    /// three intervals (and `[t_min, t_max]`) overlap.
    pub fn hit(&self, ray: &Ray, mut t_min: f64, mut t_max: f64) -> bool {
        for axis in 0..3 {
            // Dividing by a zero direction gives ±infinity, which works out: the
            // interval is everything if the origin is inside the slab, else nothing.
            let inv_d = 1.0 / ray.direction[axis];
            let mut t0 = (self.min[axis] - ray.origin[axis]) * inv_d;
            let mut t1 = (self.max[axis] - ray.origin[axis]) * inv_d;
            if inv_d < 0.0 {
                std::mem::swap(&mut t0, &mut t1);
            }
            // f64::max/min ignore NaN, which appears for 0 * infinity when the
            // origin lies exactly on a face of the slab.
            t_min = t_min.max(t0);
            t_max = t_max.min(t1);
            if t_max < t_min {
                return false;
            }
        }
        true
    }
}

/// Leaves hold up to this many objects.
const MAX_LEAF_SIZE: usize = 2;

#[derive(Debug, Clone, Copy)]
enum Node {
    /// Objects `start..start + count` of `Bvh::objects`.
    Leaf {
        bbox: Aabb,
        start: usize,
        count: usize,
    },
    /// Two children (indices into `Bvh::nodes`), split along `axis`.
    Interior {
        bbox: Aabb,
        left: usize,
        right: usize,
        axis: usize,
    },
}

impl Node {
    fn bbox(&self) -> Aabb {
        match *self {
            Node::Leaf { bbox, .. } | Node::Interior { bbox, .. } => bbox,
        }
    }
}

/// A bounding volume hierarchy stored as a flat array of nodes; node 0 is the root.
pub struct Bvh {
    objects: Vec<Box<dyn Hittable>>,
    nodes: Vec<Node>,
}

impl Bvh {
    /// Build the tree. At each node: box everything, find the longest axis of the
    /// object centers, sort along it, and split the list in half.
    pub fn new(objects: Vec<Box<dyn Hittable>>) -> Self {
        let mut items: Vec<(Box<dyn Hittable>, Aabb)> = objects
            .into_iter()
            .map(|object| {
                let bbox = object.bounding_box();
                (object, bbox)
            })
            .collect();
        let mut nodes = Vec::with_capacity(items.len());
        if !items.is_empty() {
            build(&mut items, 0, &mut nodes);
        }
        Bvh {
            objects: items.into_iter().map(|(object, _)| object).collect(),
            nodes,
        }
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    /// Number of levels from the root to the deepest leaf (0 when empty).
    pub fn depth(&self) -> usize {
        fn go(nodes: &[Node], i: usize) -> usize {
            match nodes[i] {
                Node::Leaf { .. } => 1,
                Node::Interior { left, right, .. } => 1 + go(nodes, left).max(go(nodes, right)),
            }
        }
        if self.nodes.is_empty() {
            0
        } else {
            go(&self.nodes, 0)
        }
    }
}

/// Build the subtree for `items` (which start at `offset` in the final object list)
/// and return its node index.
fn build(items: &mut [(Box<dyn Hittable>, Aabb)], offset: usize, nodes: &mut Vec<Node>) -> usize {
    let bbox = items
        .iter()
        .fold(Aabb::EMPTY, |acc, (_, b)| acc.surrounding(*b));
    let index = nodes.len();
    if items.len() <= MAX_LEAF_SIZE {
        nodes.push(Node::Leaf {
            bbox,
            start: offset,
            count: items.len(),
        });
        return index;
    }

    // Split along the axis where the object centers are most spread out.
    let centers = items.iter().fold(Aabb::EMPTY, |acc, (_, b)| {
        acc.surrounding(Aabb::new(b.centroid(), b.centroid()))
    });
    let axis = centers.longest_axis();
    items.sort_by(|a, b| a.1.centroid()[axis].total_cmp(&b.1.centroid()[axis]));

    nodes.push(Node::Leaf {
        bbox,
        start: 0,
        count: 0,
    }); // placeholder, replaced below
    let mid = items.len() / 2;
    let (lo, hi) = items.split_at_mut(mid);
    let left = build(lo, offset, nodes);
    let right = build(hi, offset + mid, nodes);
    nodes[index] = Node::Interior {
        bbox,
        left,
        right,
        axis,
    };
    index
}

impl Hittable for Bvh {
    fn hit(&self, ray: &Ray, t_min: f64, t_max: f64) -> Option<HitRecord> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut closest: Option<HitRecord> = None;
        let mut limit = t_max;
        // Halving splits keep the depth near log2(n), so 64 slots is plenty.
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = &self.nodes[stack[top]];
            // `limit` shrinks as hits are found, so far boxes get skipped.
            if !node.bbox().hit(ray, t_min, limit) {
                continue;
            }
            match *node {
                Node::Leaf { start, count, .. } => {
                    for object in &self.objects[start..start + count] {
                        if let Some(rec) = object.hit(ray, t_min, limit) {
                            limit = rec.t;
                            closest = Some(rec);
                        }
                    }
                }
                Node::Interior {
                    left, right, axis, ..
                } => {
                    // Visit the child nearer the ray first (pushed last), so its
                    // hit can rule out the farther child.
                    let (near, far) = if ray.direction[axis] < 0.0 {
                        (right, left)
                    } else {
                        (left, right)
                    };
                    stack[top] = far;
                    stack[top + 1] = near;
                    top += 2;
                }
            }
        }
        closest
    }

    fn bounding_box(&self) -> Aabb {
        self.nodes.first().map_or(Aabb::EMPTY, Node::bbox)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hittable::HittableList;
    use crate::material::Material;
    use crate::rng::{Rng, seeded};
    use crate::sphere::Sphere;
    use crate::vec3::{Color, random_unit_vector};
    use rand::Rng as _;

    fn unit_box() -> Aabb {
        Aabb::new(Vec3::new(-1.0, -1.0, -1.0), Vec3::new(1.0, 1.0, 1.0))
    }

    fn ray(origin: (f64, f64, f64), dir: (f64, f64, f64)) -> Ray {
        Ray::new(
            Vec3::new(origin.0, origin.1, origin.2),
            Vec3::new(dir.0, dir.1, dir.2),
        )
    }

    const INF: f64 = f64::INFINITY;

    #[test]
    fn aabb_new_orders_corners() {
        let b = Aabb::new(Vec3::new(1.0, -2.0, 3.0), Vec3::new(-1.0, 2.0, 0.0));
        assert_eq!(b.min, Vec3::new(-1.0, -2.0, 0.0));
        assert_eq!(b.max, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(b.centroid(), Vec3::new(0.0, 0.0, 1.5));
    }

    #[test]
    fn aabb_surrounding_and_empty() {
        let a = Aabb::new(Vec3::ZERO, Vec3::ONE);
        let b = Aabb::new(Vec3::new(2.0, -1.0, 0.5), Vec3::new(3.0, 0.0, 0.7));
        let s = a.surrounding(b);
        assert_eq!(s.min, Vec3::new(0.0, -1.0, 0.0));
        assert_eq!(s.max, Vec3::new(3.0, 1.0, 1.0));
        assert_eq!(Aabb::EMPTY.surrounding(a), a);
        assert!(!Aabb::EMPTY.hit(&ray((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), -INF, INF));
    }

    #[test]
    fn aabb_longest_axis() {
        let along = |x, y, z| Aabb::new(Vec3::ZERO, Vec3::new(x, y, z)).longest_axis();
        assert_eq!(along(5.0, 1.0, 1.0), 0);
        assert_eq!(along(1.0, 5.0, 1.0), 1);
        assert_eq!(along(1.0, 1.0, 5.0), 2);
        assert_eq!(along(2.0, 2.0, 2.0), 0);
    }

    #[test]
    fn aabb_hit_straight_through() {
        assert!(unit_box().hit(&ray((0.0, 0.0, 5.0), (0.0, 0.0, -1.0)), 0.0, INF));
        assert!(unit_box().hit(&ray((-5.0, -5.0, -5.0), (1.0, 1.0, 1.0)), 0.0, INF));
        // Negative direction components.
        assert!(unit_box().hit(&ray((4.0, 3.0, 2.0), (-4.0, -3.0, -2.0)), 0.0, INF));
    }

    #[test]
    fn aabb_miss() {
        assert!(!unit_box().hit(&ray((0.0, 3.0, 5.0), (0.0, 0.0, -1.0)), 0.0, INF));
        // Passes beside a corner: inside the x slab and the y slab, but never both.
        assert!(!unit_box().hit(&ray((-3.0, 0.0, 0.0), (1.0, 1.5, 0.0)), 0.0, INF));
        // Pointing away.
        assert!(!unit_box().hit(&ray((0.0, 0.0, 5.0), (0.0, 0.0, 1.0)), 0.0, INF));
    }

    #[test]
    fn aabb_parallel_rays() {
        // Parallel to the x axis: hits only if y and z are inside the box.
        assert!(unit_box().hit(&ray((-5.0, 0.5, 0.5), (1.0, 0.0, 0.0)), 0.0, INF));
        assert!(!unit_box().hit(&ray((-5.0, 1.5, 0.5), (1.0, 0.0, 0.0)), 0.0, INF));
        // Origin exactly on a face plane (0 * infinity = NaN) still counts as touching.
        assert!(unit_box().hit(&ray((-5.0, 1.0, 0.0), (1.0, 0.0, 0.0)), 0.0, INF));
    }

    #[test]
    fn aabb_respects_t_bounds() {
        let r = ray((0.0, 0.0, 5.0), (0.0, 0.0, -1.0)); // inside for t in [4, 6]
        assert!(!unit_box().hit(&r, 0.0, 3.9));
        assert!(unit_box().hit(&r, 0.0, 4.1));
        assert!(unit_box().hit(&r, 5.0, 5.5));
        assert!(!unit_box().hit(&r, 6.1, INF));
        // Starting inside the box is a hit.
        assert!(unit_box().hit(&ray((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)), 0.0, INF));
    }

    #[test]
    fn aabb_flat_box_can_still_be_hit() {
        let flat = Aabb::new(Vec3::new(-1.0, 0.0, -1.0), Vec3::new(1.0, 0.0, 1.0));
        assert!(flat.hit(&ray((0.0, 5.0, 0.0), (0.0, -1.0, 0.0)), 0.0, INF));
    }

    #[test]
    fn sphere_bounding_box() {
        let s = Sphere::new(Vec3::new(1.0, 2.0, 3.0), 0.5, Material::dielectric(1.5));
        let b = s.bounding_box();
        assert_eq!(b.min, Vec3::new(0.5, 1.5, 2.5));
        assert_eq!(b.max, Vec3::new(1.5, 2.5, 3.5));
    }

    fn random_spheres(rng: &mut Rng, n: usize) -> Vec<Sphere> {
        let gray = Material::lambertian(Color::new(0.5, 0.5, 0.5));
        (0..n)
            .map(|_| {
                let center = Vec3::random_range(rng, -10.0, 10.0);
                Sphere::new(center, rng.random_range(0.1..2.0), gray)
            })
            .collect()
    }

    fn boxed(spheres: &[Sphere]) -> Vec<Box<dyn Hittable>> {
        spheres
            .iter()
            .map(|s| Box::new(*s) as Box<dyn Hittable>)
            .collect()
    }

    fn list_of(spheres: &[Sphere]) -> HittableList {
        HittableList {
            objects: boxed(spheres),
        }
    }

    #[test]
    fn bvh_matches_brute_force_on_random_scenes() {
        let mut hits = 0;
        for scene_seed in 0..10 {
            let mut rng = seeded(1000 + scene_seed);
            let n = [1, 2, 3, 7, 20, 50, 100, 200, 333, 500][scene_seed as usize];
            let spheres = random_spheres(&mut rng, n);
            let list = list_of(&spheres);
            let bvh = Bvh::new(boxed(&spheres));
            assert_eq!(bvh.len(), n);
            assert_eq!(bvh.bounding_box(), list.bounding_box());

            for i in 0..1000 {
                let origin = Vec3::random_range(&mut rng, -15.0, 15.0);
                // Half the rays point anywhere, half aim into the scene.
                let direction = if i % 2 == 0 {
                    random_unit_vector(&mut rng)
                } else {
                    Vec3::random_range(&mut rng, -8.0, 8.0) - origin
                };
                let r = Ray::new(origin, direction);
                let expected = list.hit(&r, 0.001, INF);
                assert_eq!(bvh.hit(&r, 0.001, INF), expected);
                hits += expected.is_some() as usize;
                // Also with a finite t_max.
                assert_eq!(bvh.hit(&r, 0.001, 8.0), list.hit(&r, 0.001, 8.0));
            }
        }
        // Make sure the comparison isn't vacuous.
        assert!(hits > 2000, "{hits}");
    }

    /// Every object sits inside its leaf's box, and every child inside its parent's.
    #[test]
    fn bvh_boxes_nest() {
        let spheres = random_spheres(&mut seeded(5), 300);
        let bvh = Bvh::new(boxed(&spheres));
        let contains = |outer: Aabb, inner: Aabb| {
            (0..3).all(|a| outer.min[a] <= inner.min[a] && inner.max[a] <= outer.max[a])
        };
        let mut seen = 0;
        for node in &bvh.nodes {
            match *node {
                Node::Leaf { bbox, start, count } => {
                    assert!((1..=MAX_LEAF_SIZE).contains(&count));
                    for object in &bvh.objects[start..start + count] {
                        assert!(contains(bbox, object.bounding_box()));
                    }
                    seen += count;
                }
                Node::Interior {
                    bbox, left, right, ..
                } => {
                    assert!(contains(bbox, bvh.nodes[left].bbox()));
                    assert!(contains(bbox, bvh.nodes[right].bbox()));
                }
            }
        }
        assert_eq!(seen, 300);
        // Halving each level: 300, 150, 75, 38, 19, 10, 5, 3, 2 objects: 9 levels.
        assert_eq!(bvh.depth(), 9);
    }

    #[test]
    fn empty_bvh_never_hits() {
        let bvh = Bvh::new(Vec::new());
        assert!(bvh.is_empty());
        assert_eq!(bvh.depth(), 0);
        assert_eq!(bvh.bounding_box(), Aabb::EMPTY);
        assert!(
            bvh.hit(&ray((0.0, 0.0, 0.0), (0.0, 0.0, -1.0)), 0.0, INF)
                .is_none()
        );
    }

    #[test]
    fn single_object_bvh() {
        let s = Sphere::new(Vec3::new(0.0, 0.0, -3.0), 1.0, Material::dielectric(1.5));
        let bvh = Bvh::new(boxed(&[s]));
        assert_eq!(bvh.depth(), 1);
        let r = ray((0.0, 0.0, 0.0), (0.0, 0.0, -1.0));
        assert_eq!(bvh.hit(&r, 0.0, INF), s.hit(&r, 0.0, INF));
        assert_eq!(bvh.hit(&r, 0.0, INF).unwrap().t, 2.0);
    }

    #[test]
    fn bvh_can_nest_inside_a_list() {
        // A BVH is itself a Hittable, so it can be one object among others.
        let spheres = random_spheres(&mut seeded(8), 40);
        let mut outer = HittableList::new();
        outer.add(Bvh::new(boxed(&spheres)));
        let list = list_of(&spheres);
        let mut rng = seeded(9);
        for _ in 0..200 {
            let r = Ray::new(Vec3::ZERO, random_unit_vector(&mut rng));
            assert_eq!(outer.hit(&r, 0.001, INF), list.hit(&r, 0.001, INF));
        }
    }
}
