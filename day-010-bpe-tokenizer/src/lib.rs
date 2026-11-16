//! A byte-level BPE tokenizer in the style of GPT-2 and GPT-4.
//!
//! The base vocabulary is the 256 possible byte values, so any input
//! (any UTF-8 string, in fact any byte sequence) can be represented.
//! Training learns merges of adjacent tokens on top of that base.

use std::fmt;

pub mod bpe;
pub mod pretokenize;
pub mod vocab;

pub use bpe::{Decoded, Tokenizer, TrainOptions, TrainReport, train};
pub use pretokenize::Pattern;
pub use vocab::{BASE_VOCAB_SIZE, Vocab};

/// Everything that can go wrong in the library.
#[derive(Debug)]
pub enum Error {
    /// The requested vocabulary is smaller than the 256 base tokens.
    VocabTooSmall { requested: usize, minimum: usize },
    /// A token id passed to decode is not in the vocabulary.
    UnknownTokenId { id: u32, vocab_size: usize },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::VocabTooSmall { requested, minimum } => write!(
                f,
                "vocab size {requested} is too small: it must be at least {minimum}"
            ),
            Error::UnknownTokenId { id, vocab_size } => write!(
                f,
                "token id {id} is not in the vocabulary (valid ids are 0..{vocab_size})"
            ),
        }
    }
}

impl std::error::Error for Error {}
