//! A byte-level BPE tokenizer in the style of GPT-2 and GPT-4.
//!
//! The base vocabulary is the 256 possible byte values, so any input
//! (any UTF-8 string, in fact any byte sequence) can be represented.
//! Training learns merges of adjacent tokens on top of that base.

pub mod vocab;

pub use vocab::{BASE_VOCAB_SIZE, Vocab};
