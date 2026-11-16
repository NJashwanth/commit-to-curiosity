//! A byte-level BPE tokenizer in the style of GPT-2 and GPT-4.
//!
//! The base vocabulary is the 256 possible byte values, so any input
//! (any UTF-8 string, in fact any byte sequence) can be represented.
//! Training learns merges of adjacent tokens on top of that base.

use std::{fmt, io};

pub mod bpe;
pub mod cli;
pub mod pretokenize;
pub mod vocab;

pub use bpe::{Decoded, Tokenizer, TrainOptions, TrainReport, train};
pub use pretokenize::Pattern;
pub use vocab::{BASE_VOCAB_SIZE, Vocab};

/// Everything that can go wrong in the library.
#[derive(Debug)]
pub enum Error {
    /// The requested vocabulary is smaller than the 256 base tokens.
    VocabTooSmall {
        requested: usize,
        minimum: usize,
    },
    /// A token id passed to decode is not in the vocabulary.
    UnknownTokenId {
        id: u32,
        vocab_size: usize,
    },
    /// A special token is empty or listed twice.
    InvalidSpecialToken(String),
    /// A vocab file parsed as JSON but its contents are inconsistent.
    InvalidVocab(String),
    Io(io::Error),
    Json(serde_json::Error),
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
            Error::InvalidSpecialToken(msg) => write!(f, "invalid special token: {msg}"),
            Error::InvalidVocab(msg) => write!(f, "invalid vocab file: {msg}"),
            Error::Io(err) => write!(f, "{err}"),
            Error::Json(err) => write!(f, "vocab file is not valid JSON: {err}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(err) => Some(err),
            Error::Json(err) => Some(err),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err)
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::Json(err)
    }
}
