//! A byte-level BPE tokenizer in the style of GPT-2 and GPT-4.
//!
//! The base vocabulary is the 256 possible byte values, so any input
//! (any UTF-8 string, in fact any byte sequence) can be represented.
//! Training learns merges of adjacent tokens on top of that base.

use std::fmt;

pub mod bpe;
pub mod vocab;

pub use bpe::{TrainOptions, TrainReport, train};
pub use vocab::{BASE_VOCAB_SIZE, Vocab};

/// Everything that can go wrong in the library.
#[derive(Debug)]
pub enum Error {
    /// The requested vocabulary is smaller than the 256 base tokens.
    VocabTooSmall { requested: usize, minimum: usize },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::VocabTooSmall { requested, minimum } => write!(
                f,
                "vocab size {requested} is too small: it must be at least {minimum}"
            ),
        }
    }
}

impl std::error::Error for Error {}
