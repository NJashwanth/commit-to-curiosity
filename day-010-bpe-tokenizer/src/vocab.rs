//! The vocabulary: token id to bytes, plus the ordered list of merges.
//!
//! Ids `0..256` are the raw byte values. Merge number `r` (its rank) creates
//! token `256 + r`, whose bytes are the concatenation of the two tokens it
//! merges. A lower rank means the merge was learned earlier.

use std::collections::HashMap;

/// Number of base tokens: one per possible byte value.
pub const BASE_VOCAB_SIZE: usize = 256;

/// Two adjacent token ids.
pub type Pair = (u32, u32);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vocab {
    /// Bytes for every regular token, indexed by id.
    tokens: Vec<Vec<u8>>,
    /// Merges in the order they were learned.
    merges: Vec<Pair>,
    /// Pair to rank, for encoding.
    ranks: HashMap<Pair, u32>,
}

impl Vocab {
    /// The base vocabulary: token `i` is the single byte `i`.
    pub fn byte_level() -> Self {
        Self {
            tokens: (0..=255u8).map(|b| vec![b]).collect(),
            merges: Vec::new(),
            ranks: HashMap::new(),
        }
    }

    /// Append a merge and return the id of the new token.
    ///
    /// Both ids must already exist and the pair must not be merged already.
    pub(crate) fn push_merge(&mut self, a: u32, b: u32) -> u32 {
        let id = self.tokens.len() as u32;
        assert!(
            a < id && b < id,
            "merge ({a}, {b}) refers to an unknown token"
        );
        let rank = self.merges.len() as u32;
        let previous = self.ranks.insert((a, b), rank);
        assert!(previous.is_none(), "pair ({a}, {b}) is already merged");
        let mut bytes = self.tokens[a as usize].clone();
        bytes.extend_from_slice(&self.tokens[b as usize]);
        self.tokens.push(bytes);
        self.merges.push((a, b));
        id
    }

    /// The merges in rank order. Merge `r` produced token `256 + r`.
    pub fn merges(&self) -> &[Pair] {
        &self.merges
    }

    /// The rank of a pair, if it was merged.
    pub fn rank(&self, pair: Pair) -> Option<u32> {
        self.ranks.get(&pair).copied()
    }

    /// Total number of token ids.
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Always false: a vocabulary contains at least the 256 byte tokens.
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    /// The bytes a token stands for, or `None` for an id outside the vocabulary.
    pub fn token_bytes(&self, id: u32) -> Option<&[u8]> {
        self.tokens.get(id as usize).map(Vec::as_slice)
    }

    /// A printable form of a token, for listings and visualisation.
    pub fn display_token(&self, id: u32) -> Option<String> {
        self.token_bytes(id).map(escape_bytes)
    }
}

/// Render bytes as text, escaping control characters and showing bytes that
/// are not valid UTF-8 on their own as `\xNN`.
pub fn escape_bytes(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
                c => out.push(c),
            }
        }
        for b in chunk.invalid() {
            out.push_str(&format!("\\x{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_ids(text: &str) -> Vec<u32> {
        text.bytes().map(u32::from).collect()
    }

    fn from_ids(vocab: &Vocab, ids: &[u32]) -> Vec<u8> {
        ids.iter()
            .flat_map(|&id| vocab.token_bytes(id).unwrap().to_vec())
            .collect()
    }

    #[test]
    fn base_vocab_has_one_token_per_byte() {
        let vocab = Vocab::byte_level();
        assert_eq!(vocab.len(), BASE_VOCAB_SIZE);
        assert!(!vocab.is_empty());
        for b in 0..=255u8 {
            assert_eq!(vocab.token_bytes(u32::from(b)), Some(&[b][..]));
        }
    }

    #[test]
    fn ids_outside_the_base_vocab_are_unknown() {
        let vocab = Vocab::byte_level();
        assert_eq!(vocab.token_bytes(256), None);
        assert_eq!(vocab.token_bytes(u32::MAX), None);
        assert_eq!(vocab.display_token(256), None);
    }

    #[test]
    fn any_utf8_round_trips_through_byte_tokens() {
        let vocab = Vocab::byte_level();
        for text in [
            "",
            "To be, or not to be",
            "Hello 👋 world",
            "నమస్తే",
            "mixed: ünïcödé, 日本語, Ελληνικά, 🎉🚀",
            " \t\n  \r\n",
        ] {
            let ids = to_ids(text);
            assert_eq!(ids.len(), text.len(), "one token per byte");
            assert!(ids.iter().all(|&id| (id as usize) < BASE_VOCAB_SIZE));
            assert_eq!(from_ids(&vocab, &ids), text.as_bytes());
        }
    }

    #[test]
    fn escape_shows_control_chars_and_partial_utf8() {
        assert_eq!(escape_bytes(b"a b"), "a b");
        assert_eq!(escape_bytes(b"line\n\tend\r"), "line\\n\\tend\\r");
        assert_eq!(escape_bytes(&[0x07]), "\\u{7}");
        // The first two bytes of 👋 (F0 9F 91 8B) are not valid UTF-8 on their own.
        assert_eq!(escape_bytes(&[0xF0, 0x9F]), "\\xF0\\x9F");
        assert_eq!(escape_bytes("👋".as_bytes()), "👋");
        assert_eq!(escape_bytes(&[b'h', 0xFF, b'i']), "h\\xFFi");
    }

    #[test]
    fn push_merge_concatenates_bytes_and_records_rank() {
        let mut vocab = Vocab::byte_level();
        let th = vocab.push_merge(u32::from(b't'), u32::from(b'h'));
        let the = vocab.push_merge(th, u32::from(b'e'));
        assert_eq!((th, the), (256, 257));
        assert_eq!(vocab.len(), 258);
        assert_eq!(vocab.token_bytes(the), Some(&b"the"[..]));
        assert_eq!(vocab.merges(), &[(116, 104), (256, 101)]);
        assert_eq!(vocab.rank((116, 104)), Some(0));
        assert_eq!(vocab.rank((256, 101)), Some(1));
        assert_eq!(vocab.rank((101, 116)), None);
    }

    #[test]
    #[should_panic(expected = "unknown token")]
    fn push_merge_rejects_unknown_ids() {
        Vocab::byte_level().push_merge(0, 999);
    }

    #[test]
    #[should_panic(expected = "already merged")]
    fn push_merge_rejects_duplicates() {
        let mut vocab = Vocab::byte_level();
        vocab.push_merge(1, 2);
        vocab.push_merge(1, 2);
    }

    #[test]
    fn display_token_uses_escaping() {
        let vocab = Vocab::byte_level();
        assert_eq!(vocab.display_token(u32::from(b'A')).unwrap(), "A");
        assert_eq!(vocab.display_token(10).unwrap(), "\\n");
        assert_eq!(vocab.display_token(0xE0).unwrap(), "\\xE0");
    }
}
