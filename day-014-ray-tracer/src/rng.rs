//! Seeded random numbers, so the same seed always gives the same image.

use rand::SeedableRng;

/// The generator used everywhere: small, fast and fully determined by its seed.
pub type Rng = rand_pcg::Pcg64Mcg;

/// A generator for `seed`.
pub fn seeded(seed: u64) -> Rng {
    Rng::seed_from_u64(seed)
}

/// An independent generator for one stream (an image row, a scene generator, ...).
///
/// Giving every row its own stream means the image doesn't depend on which order
/// rows are rendered in, which is what makes the parallel renderer deterministic.
pub fn stream(seed: u64, index: u64) -> Rng {
    seeded(seed ^ index.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng as _;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = seeded(42);
        let mut b = seeded(42);
        for _ in 0..100 {
            assert_eq!(a.random::<u64>(), b.random::<u64>());
        }
    }

    #[test]
    fn different_seeds_differ() {
        assert_ne!(seeded(1).random::<u64>(), seeded(2).random::<u64>());
    }

    #[test]
    fn streams_are_reproducible_and_distinct() {
        assert_eq!(stream(7, 3).random::<u64>(), stream(7, 3).random::<u64>());
        assert_ne!(stream(7, 3).random::<u64>(), stream(7, 4).random::<u64>());
        assert_ne!(stream(7, 3).random::<u64>(), stream(8, 3).random::<u64>());
        // Stream 0 is not just the plain seed.
        assert_ne!(stream(7, 0).random::<u64>(), seeded(7).random::<u64>());
    }
}
