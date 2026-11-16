//! Training: learn merges by repeatedly fusing the most frequent adjacent pair.
//!
//! The naive algorithm recounts every pair after every merge. Here the counts
//! are kept up to date incrementally: every chunk lives in one arena as a
//! doubly linked list of symbols, each pair remembers where it occurs, and a
//! max-heap (with lazy deletion of stale entries) finds the next best pair.
//! A merge then only touches the places where that pair actually occurs.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::time::{Duration, Instant};

use indicatif::{ProgressBar, ProgressStyle};

use crate::Error;
use crate::vocab::{BASE_VOCAB_SIZE, Pair, Vocab};

/// Settings for [`train`].
#[derive(Clone, Debug)]
pub struct TrainOptions {
    /// Final vocabulary size, including the 256 byte tokens.
    pub vocab_size: usize,
    /// Draw a progress bar on stderr.
    pub progress: bool,
}

impl Default for TrainOptions {
    fn default() -> Self {
        Self {
            vocab_size: 1024,
            progress: false,
        }
    }
}

/// What happened during training.
#[derive(Clone, Debug)]
pub struct TrainReport {
    /// Merges learned.
    pub merges: usize,
    /// Merges needed to reach the requested vocab size.
    pub requested_merges: usize,
    /// Distinct chunks the text was split into.
    pub unique_chunks: usize,
    /// Size of the training text in bytes.
    pub input_bytes: usize,
    pub elapsed: Duration,
}

impl TrainReport {
    /// True if the text ran out of pairs before the vocab size was reached.
    pub fn stopped_early(&self) -> bool {
        self.merges < self.requested_merges
    }
}

/// Learn a vocabulary of `opts.vocab_size` tokens from `text`.
///
/// Ties between equally frequent pairs go to the smallest pair `(a, b)`,
/// compared by `a` and then `b`, so training is fully deterministic.
pub fn train(text: &str, opts: &TrainOptions) -> Result<(Vocab, TrainReport), Error> {
    if opts.vocab_size < BASE_VOCAB_SIZE {
        return Err(Error::VocabTooSmall {
            requested: opts.vocab_size,
            minimum: BASE_VOCAB_SIZE,
        });
    }
    let start = Instant::now();
    let requested_merges = opts.vocab_size - BASE_VOCAB_SIZE;
    let chunks = count_chunks(std::iter::once(text));
    let merges = learn_merges(&chunks, requested_merges, opts.progress);

    let mut vocab = Vocab::byte_level();
    for &(a, b) in &merges {
        vocab.push_merge(a, b);
    }
    let report = TrainReport {
        merges: merges.len(),
        requested_merges,
        unique_chunks: chunks.len(),
        input_bytes: text.len(),
        elapsed: start.elapsed(),
    };
    Ok((vocab, report))
}

/// Count identical chunks so each distinct one is processed once, weighted by
/// how often it appears. Sorted so the arena layout is the same on every run.
fn count_chunks<'a>(pieces: impl Iterator<Item = &'a str>) -> Vec<(&'a [u8], u64)> {
    let mut counts: HashMap<&[u8], u64> = HashMap::new();
    for piece in pieces.filter(|p| !p.is_empty()) {
        *counts.entry(piece.as_bytes()).or_default() += 1;
    }
    let mut chunks: Vec<_> = counts.into_iter().collect();
    chunks.sort_unstable();
    chunks
}

/// Marks "no neighbour" in the linked lists.
const NONE: u32 = u32::MAX;
/// Symbol value of a position that was absorbed into its left neighbour.
const DEAD: u32 = u32::MAX - 1;

/// Learn up to `n_merges` merges from weighted chunks. Pairs never span two
/// chunks. Returns the merges in the order they were learned.
pub(crate) fn learn_merges(chunks: &[(&[u8], u64)], n_merges: usize, progress: bool) -> Vec<Pair> {
    let total: usize = chunks.iter().map(|(c, _)| c.len()).sum();
    let mut sym: Vec<u32> = Vec::with_capacity(total);
    let mut prev: Vec<u32> = Vec::with_capacity(total);
    let mut next: Vec<u32> = Vec::with_capacity(total);
    let mut weight: Vec<i64> = Vec::with_capacity(total);
    for &(bytes, freq) in chunks {
        let start = sym.len() as u32;
        for (i, &b) in bytes.iter().enumerate() {
            let pos = start + i as u32;
            sym.push(u32::from(b));
            prev.push(if i == 0 { NONE } else { pos - 1 });
            next.push(if i + 1 == bytes.len() { NONE } else { pos + 1 });
            weight.push(freq as i64);
        }
    }

    // Weighted count of every adjacent pair, and the positions where it starts.
    let mut counts: HashMap<Pair, i64> = HashMap::new();
    let mut places: HashMap<Pair, Vec<u32>> = HashMap::new();
    for pos in 0..sym.len() {
        let n = next[pos];
        if n != NONE {
            let pair = (sym[pos], sym[n as usize]);
            *counts.entry(pair).or_default() += weight[pos];
            places.entry(pair).or_default().push(pos as u32);
        }
    }

    // Max-heap on count, then on the smallest pair (Reverse) to break ties.
    // Entries can be stale; they are checked against `counts` when popped.
    let mut heap: BinaryHeap<(i64, Reverse<Pair>)> = counts
        .iter()
        .map(|(&pair, &count)| (count, Reverse(pair)))
        .collect();

    let bar = progress_bar(n_merges, progress);
    let mut merges = Vec::with_capacity(n_merges);
    let mut grown: Vec<Pair> = Vec::new();

    while merges.len() < n_merges {
        let Some((count, Reverse(pair))) = heap.pop() else {
            break; // no pairs left anywhere
        };
        let actual = counts.get(&pair).copied().unwrap_or(0);
        if actual <= 0 || actual != count {
            // Stale. If the count dropped, requeue it at its real value. If it
            // grew, a fresher entry was pushed when it grew, so drop this one.
            if 0 < actual && actual < count {
                heap.push((actual, Reverse(pair)));
            }
            continue;
        }

        let new_id = (BASE_VOCAB_SIZE + merges.len()) as u32;
        merges.push(pair);
        let (a, b) = pair;
        let mut positions = places.remove(&pair).unwrap_or_default();
        positions.sort_unstable();
        positions.dedup();

        for pos in positions {
            let i = pos as usize;
            // The recorded place may be stale: check the pair is still there.
            if sym[i] != a {
                continue;
            }
            let j = next[i];
            if j == NONE || sym[j as usize] != b {
                continue;
            }
            let w = weight[i];
            let before = prev[i];
            let after = next[j as usize];

            // Remove the pairs that disappear...
            *counts.get_mut(&pair).expect("merged pair is counted") -= w;
            if before != NONE {
                *counts
                    .get_mut(&(sym[before as usize], a))
                    .expect("left pair is counted") -= w;
            }
            if after != NONE {
                *counts
                    .get_mut(&(b, sym[after as usize]))
                    .expect("right pair is counted") -= w;
            }

            // ...fuse j into i...
            sym[i] = new_id;
            next[i] = after;
            if after != NONE {
                prev[after as usize] = pos;
            }
            sym[j as usize] = DEAD;

            // ...and add the pairs that appear.
            if before != NONE {
                let left = (sym[before as usize], new_id);
                *counts.entry(left).or_default() += w;
                places.entry(left).or_default().push(before);
                grown.push(left);
            }
            if after != NONE {
                let right = (new_id, sym[after as usize]);
                *counts.entry(right).or_default() += w;
                places.entry(right).or_default().push(pos);
                grown.push(right);
            }
        }
        counts.remove(&pair);

        grown.sort_unstable();
        grown.dedup();
        for p in grown.drain(..) {
            // A pair can appear and vanish again within one pass; skip those.
            let c = counts[&p];
            if c > 0 {
                heap.push((c, Reverse(p)));
            }
        }
        bar.inc(1);
    }
    bar.finish_and_clear();
    merges
}

fn progress_bar(len: usize, enabled: bool) -> ProgressBar {
    if !enabled {
        return ProgressBar::hidden();
    }
    let bar = ProgressBar::new(len as u64);
    bar.set_style(
        ProgressStyle::with_template(
            "training {bar:40.cyan/blue} {pos}/{len} merges [{elapsed_precise}, {per_sec}]",
        )
        .expect("valid progress template")
        .progress_chars("=> "),
    );
    bar
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The textbook algorithm: recount all pairs, merge the best, repeat.
    pub(crate) fn naive_merges(chunks: &[(&[u8], u64)], n_merges: usize) -> Vec<Pair> {
        let mut words: Vec<(Vec<u32>, u64)> = chunks
            .iter()
            .map(|&(c, f)| (c.iter().map(|&b| u32::from(b)).collect(), f))
            .collect();
        let mut merges = Vec::new();
        while merges.len() < n_merges {
            let mut counts: std::collections::BTreeMap<Pair, u64> = Default::default();
            for (w, f) in &words {
                for p in w.windows(2) {
                    *counts.entry((p[0], p[1])).or_default() += f;
                }
            }
            // BTreeMap iterates pairs in ascending order; keep the first maximum.
            let mut best: Option<(Pair, u64)> = None;
            for (&p, &c) in &counts {
                if best.is_none_or(|(_, bc)| c > bc) {
                    best = Some((p, c));
                }
            }
            let Some((pair, _)) = best else { break };
            let id = (BASE_VOCAB_SIZE + merges.len()) as u32;
            for (w, _) in &mut words {
                *w = merge_word(w, pair, id);
            }
            merges.push(pair);
        }
        merges
    }

    /// Replace every occurrence of `pair` in `word`, left to right.
    pub(crate) fn merge_word(word: &[u32], pair: Pair, id: u32) -> Vec<u32> {
        let mut out = Vec::with_capacity(word.len());
        let mut i = 0;
        while i < word.len() {
            if i + 1 < word.len() && (word[i], word[i + 1]) == pair {
                out.push(id);
                i += 2;
            } else {
                out.push(word[i]);
                i += 1;
            }
        }
        out
    }

    /// Tiny deterministic generator so tests need no extra crates.
    pub(crate) struct Lcg(pub u64);
    impl Lcg {
        pub(crate) fn below(&mut self, n: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) % n
        }
    }

    fn opts(vocab_size: usize) -> TrainOptions {
        TrainOptions {
            vocab_size,
            ..Default::default()
        }
    }

    fn token(vocab: &Vocab, id: u32) -> String {
        String::from_utf8(vocab.token_bytes(id).unwrap().to_vec()).unwrap()
    }

    #[test]
    fn classic_aaabdaaabac_example() {
        // Wikipedia's example: aa -> Z, ab -> Y, ZY -> X gives "XdXac".
        let (vocab, report) = train("aaabdaaabac", &opts(259)).unwrap();
        let (a, b) = (u32::from(b'a'), u32::from(b'b'));
        assert_eq!(vocab.merges(), &[(a, a), (a, b), (256, 257)]);
        assert_eq!(token(&vocab, 256), "aa");
        assert_eq!(token(&vocab, 257), "ab");
        assert_eq!(token(&vocab, 258), "aaab");
        assert_eq!(report.merges, 3);
        assert!(!report.stopped_early());
        assert_eq!(report.input_bytes, 11);
        assert_eq!(report.unique_chunks, 1);
    }

    #[test]
    fn ties_go_to_the_smallest_pair() {
        // Every pair occurs once, so the order is decided purely by the tie-break.
        let (vocab, _) = train("dcba", &opts(257)).unwrap();
        assert_eq!(vocab.merges(), &[(u32::from(b'b'), u32::from(b'a'))]);
    }

    #[test]
    fn tie_breaking_is_deterministic_across_runs() {
        let text = "the cat sat on the mat; the bat ate the hat. ".repeat(20);
        let first = train(&text, &opts(400)).unwrap().0;
        for _ in 0..5 {
            assert_eq!(train(&text, &opts(400)).unwrap().0, first);
        }
        // Chunk order does not matter either.
        let chunks: Vec<(&[u8], u64)> = vec![(b"abab", 2), (b"baba", 2), (b"cdcd", 1)];
        let mut reversed = chunks.clone();
        reversed.reverse();
        assert_eq!(
            learn_merges(&chunks, 10, false),
            learn_merges(&reversed, 10, false)
        );
    }

    #[test]
    fn overlapping_runs_are_counted_and_merged_left_to_right() {
        // "aaaa" has three overlapping (a, a) pairs; merging gives "ZZ".
        let (vocab, _) = train("aaaa", &opts(258)).unwrap();
        assert_eq!(vocab.merges(), &[(97, 97), (256, 256)]);
        assert_eq!(token(&vocab, 257), "aaaa");
    }

    #[test]
    fn chunk_weights_change_the_winner() {
        let light: Vec<(&[u8], u64)> = vec![(b"ab", 1), (b"cd", 1)];
        let heavy: Vec<(&[u8], u64)> = vec![(b"ab", 1), (b"cd", 5)];
        assert_eq!(learn_merges(&light, 1, false), vec![(97, 98)]);
        assert_eq!(learn_merges(&heavy, 1, false), vec![(99, 100)]);
    }

    #[test]
    fn pairs_never_span_two_chunks() {
        let chunks: Vec<(&[u8], u64)> = vec![(b"a", 10), (b"b", 10)];
        assert!(learn_merges(&chunks, 5, false).is_empty());
    }

    #[test]
    fn matches_the_naive_algorithm_on_random_text() {
        let mut rng = Lcg(42);
        for case in 0..400 {
            let alphabet = 2 + rng.below(5) as u8;
            let n_chunks = 1 + rng.below(8) as usize;
            let owned: Vec<(Vec<u8>, u64)> = (0..n_chunks)
                .map(|_| {
                    let len = rng.below(40) as usize;
                    let bytes = (0..len)
                        .map(|_| b'a' + rng.below(u64::from(alphabet)) as u8)
                        .collect();
                    (bytes, 1 + rng.below(4))
                })
                .collect();
            let chunks: Vec<(&[u8], u64)> = owned.iter().map(|(b, f)| (b.as_slice(), *f)).collect();
            let n = rng.below(60) as usize;
            assert_eq!(
                learn_merges(&chunks, n, false),
                naive_merges(&chunks, n),
                "case {case}"
            );
        }
    }

    #[test]
    fn matches_the_naive_algorithm_on_utf8_text() {
        let text = "Hello 👋 నమస్తే world, hello again 👋👋 నమస్తే!";
        let chunks = count_chunks(std::iter::once(text));
        assert_eq!(learn_merges(&chunks, 40, false), naive_merges(&chunks, 40));
    }

    #[test]
    fn stops_early_when_pairs_run_out() {
        let (vocab, report) = train("ab", &opts(1000)).unwrap();
        assert_eq!(vocab.len(), 257);
        assert_eq!(report.merges, 1);
        assert_eq!(report.requested_merges, 744);
        assert!(report.stopped_early());

        let (vocab, report) = train("", &opts(300)).unwrap();
        assert_eq!(vocab.len(), BASE_VOCAB_SIZE);
        assert_eq!(report.unique_chunks, 0);
    }

    #[test]
    fn base_size_means_no_merges_and_smaller_is_an_error() {
        let (vocab, report) = train("hello hello", &opts(256)).unwrap();
        assert!(vocab.merges().is_empty());
        assert!(!report.stopped_early());

        let err = train("hello", &opts(255)).unwrap_err();
        assert!(matches!(
            err,
            Error::VocabTooSmall {
                requested: 255,
                minimum: 256
            }
        ));
        assert_eq!(
            err.to_string(),
            "vocab size 255 is too small: it must be at least 256"
        );
    }

    #[test]
    fn progress_bar_does_not_change_the_result() {
        let text = "low lower lowest newer newest ".repeat(10);
        let quiet = train(&text, &opts(300)).unwrap().0;
        let shown = train(
            &text,
            &TrainOptions {
                vocab_size: 300,
                progress: true,
            },
        )
        .unwrap()
        .0;
        assert_eq!(quiet, shown);
    }
}
