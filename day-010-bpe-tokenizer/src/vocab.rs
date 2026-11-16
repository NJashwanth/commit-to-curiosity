//! The vocabulary: token id to bytes, plus the ordered list of merges.
//!
//! Ids `0..256` are the raw byte values. Merge number `r` (its rank) creates
//! token `256 + r`, whose bytes are the concatenation of the two tokens it
//! merges. A lower rank means the merge was learned earlier.
//!
//! Special tokens such as `<|endoftext|>` take the ids after the last merge.
//! The whole vocabulary saves to and loads from a readable JSON file.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::Error;
use crate::pretokenize::Pattern;

/// Written into every vocab file so the loader can reject other formats.
pub const FORMAT: &str = "bpe-tokenizer/v1";

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
    /// The pre-tokenizer the merges were trained with. Encoding must use the
    /// same one. `None` means the text was treated as one long chunk.
    pattern: Option<Pattern>,
    /// Special tokens, in id order, after all regular tokens.
    special: Vec<String>,
}

impl Vocab {
    /// The base vocabulary: token `i` is the single byte `i`.
    pub fn byte_level() -> Self {
        Self {
            tokens: (0..=255u8).map(|b| vec![b]).collect(),
            merges: Vec::new(),
            ranks: HashMap::new(),
            pattern: None,
            special: Vec::new(),
        }
    }

    /// The pre-tokenization pattern, if any.
    pub fn pattern(&self) -> Option<Pattern> {
        self.pattern
    }

    pub(crate) fn set_pattern(&mut self, pattern: Option<Pattern>) {
        self.pattern = pattern;
    }

    /// Append a merge and return the id of the new token.
    ///
    /// Both ids must already exist and the pair must not be merged already.
    pub(crate) fn push_merge(&mut self, a: u32, b: u32) -> u32 {
        assert!(
            self.special.is_empty(),
            "merges must be added before special tokens"
        );
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

    /// Total number of token ids: bytes, merges and special tokens.
    pub fn len(&self) -> usize {
        self.tokens.len() + self.special.len()
    }

    /// Always false: a vocabulary contains at least the 256 byte tokens.
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    /// The bytes a token stands for, or `None` for an id outside the vocabulary.
    pub fn token_bytes(&self, id: u32) -> Option<&[u8]> {
        let id = id as usize;
        match self.tokens.get(id) {
            Some(bytes) => Some(bytes),
            None => self
                .special
                .get(id - self.tokens.len())
                .map(|s| s.as_bytes()),
        }
    }

    /// Reserve the next id for a special token. Special tokens are matched
    /// literally before pre-tokenization, so they are never split or merged.
    pub fn add_special(&mut self, token: &str) -> Result<u32, Error> {
        if token.is_empty() {
            return Err(Error::InvalidSpecialToken(
                "special tokens cannot be empty".into(),
            ));
        }
        if self.special.iter().any(|s| s == token) {
            return Err(Error::InvalidSpecialToken(format!(
                "{token:?} is listed twice"
            )));
        }
        self.special.push(token.to_owned());
        Ok((self.len() - 1) as u32)
    }

    /// Special tokens with their ids, in id order.
    pub fn special_tokens(&self) -> impl Iterator<Item = (u32, &str)> {
        let first = self.tokens.len() as u32;
        (first..).zip(self.special.iter().map(String::as_str))
    }

    /// The id of a special token.
    pub fn special_id(&self, token: &str) -> Option<u32> {
        self.special_tokens()
            .find(|&(_, s)| s == token)
            .map(|(id, _)| id)
    }

    pub fn is_special(&self, id: u32) -> bool {
        (id as usize) >= self.tokens.len() && (id as usize) < self.len()
    }

    /// Serialize as JSON with one merge per line, so the file stays readable
    /// and diffs well. Each merge also records the token it produces, for
    /// humans; the loader only needs `id` and `pair`.
    pub fn to_json(&self) -> String {
        let quote = |s: &str| serde_json::to_string(s).expect("strings serialize");
        let mut out = String::from("{\n");
        out += &format!("  \"format\": {},\n", quote(FORMAT));
        let pattern = self.pattern.map_or("null".to_owned(), |p| quote(p.name()));
        out += &format!("  \"pattern\": {pattern},\n");
        out += &format!("  \"vocab_size\": {},\n", self.len());
        let merges: Vec<String> = self
            .merges
            .iter()
            .enumerate()
            .map(|(rank, &(a, b))| {
                let id = (BASE_VOCAB_SIZE + rank) as u32;
                let token = self.display_token(id).expect("merged token exists");
                format!(
                    "    {{\"id\": {id}, \"pair\": [{a}, {b}], \"token\": {}}}",
                    quote(&token)
                )
            })
            .collect();
        out += &json_list("merges", &merges);
        out += ",\n";
        let special: Vec<String> = self
            .special_tokens()
            .map(|(id, s)| format!("    {{\"id\": {id}, \"token\": {}}}", quote(s)))
            .collect();
        out += &json_list("special_tokens", &special);
        out += "\n}\n";
        out
    }

    /// Parse and validate a vocab written by [`Vocab::to_json`].
    pub fn from_json(json: &str) -> Result<Self, Error> {
        let file: VocabFile = serde_json::from_str(json)?;
        if file.format != FORMAT {
            return Err(invalid(format!(
                "unsupported format {:?}, expected {FORMAT:?}",
                file.format
            )));
        }
        let mut vocab = Vocab::byte_level();
        if let Some(name) = &file.pattern {
            let pattern = Pattern::from_name(name)
                .ok_or_else(|| invalid(format!("unknown pattern {name:?}")))?;
            vocab.set_pattern(Some(pattern));
        }
        for entry in &file.merges {
            let expected = vocab.tokens.len() as u32;
            let [a, b] = entry.pair;
            if entry.id != expected {
                return Err(invalid(format!(
                    "merge has id {}, expected {expected}",
                    entry.id
                )));
            }
            if a >= expected || b >= expected {
                return Err(invalid(format!(
                    "merge {expected} uses a token that does not exist yet: [{a}, {b}]"
                )));
            }
            if vocab.rank((a, b)).is_some() {
                return Err(invalid(format!("pair [{a}, {b}] is merged twice")));
            }
            vocab.push_merge(a, b);
        }
        for entry in &file.special_tokens {
            let expected = vocab.len() as u32;
            if entry.id != expected {
                return Err(invalid(format!(
                    "special token {:?} has id {}, expected {expected}",
                    entry.token, entry.id
                )));
            }
            vocab.add_special(&entry.token)?;
        }
        if let Some(size) = file.vocab_size
            && size != vocab.len()
        {
            return Err(invalid(format!(
                "vocab_size says {size} but the file defines {} tokens",
                vocab.len()
            )));
        }
        Ok(vocab)
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), Error> {
        fs::write(path, self.to_json())?;
        Ok(())
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::from_json(&fs::read_to_string(path)?)
    }

    /// A printable form of a token, for listings and visualisation.
    pub fn display_token(&self, id: u32) -> Option<String> {
        self.token_bytes(id).map(escape_bytes)
    }
}

fn invalid(message: String) -> Error {
    Error::InvalidVocab(message)
}

fn json_list(key: &str, items: &[String]) -> String {
    if items.is_empty() {
        format!("  \"{key}\": []")
    } else {
        format!("  \"{key}\": [\n{}\n  ]", items.join(",\n"))
    }
}

#[derive(Deserialize)]
struct VocabFile {
    format: String,
    pattern: Option<String>,
    vocab_size: Option<usize>,
    merges: Vec<MergeEntry>,
    special_tokens: Vec<SpecialEntry>,
}

#[derive(Deserialize)]
struct MergeEntry {
    id: u32,
    pair: [u32; 2],
}

#[derive(Deserialize)]
struct SpecialEntry {
    id: u32,
    token: String,
}

/// Check a list of special tokens without building a vocab.
pub(crate) fn validate_specials(tokens: &[String]) -> Result<(), Error> {
    let mut scratch = Vocab::byte_level();
    for token in tokens {
        scratch.add_special(token)?;
    }
    Ok(())
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
    fn pattern_defaults_to_none() {
        let mut vocab = Vocab::byte_level();
        assert_eq!(vocab.pattern(), None);
        vocab.set_pattern(Some(Pattern::Gpt4));
        assert_eq!(vocab.pattern(), Some(Pattern::Gpt4));
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

    // ---- special tokens and JSON ----

    fn sample() -> Vocab {
        let mut vocab = Vocab::byte_level();
        vocab.set_pattern(Some(Pattern::Gpt4));
        let t_h = vocab.push_merge(u32::from(b't'), u32::from(b'h'));
        vocab.push_merge(u32::from(b' '), t_h);
        vocab.push_merge(0xE0, 0xB0); // first two bytes of a Telugu letter
        vocab.add_special("<|endoftext|>").unwrap();
        vocab
    }

    #[test]
    fn specials_follow_the_merges() {
        let mut vocab = sample();
        assert_eq!(vocab.len(), 260);
        assert_eq!(vocab.special_id("<|endoftext|>"), Some(259));
        assert_eq!(vocab.add_special("<|pad|>").unwrap(), 260);
        assert_eq!(vocab.display_token(260).unwrap(), "<|pad|>");
        assert!(matches!(
            vocab.add_special("<|pad|>"),
            Err(Error::InvalidSpecialToken(_))
        ));
        assert!(validate_specials(&["a".into(), "b".into()]).is_ok());
        assert!(validate_specials(&["a".into(), "a".into()]).is_err());
    }

    #[test]
    #[should_panic(expected = "before special tokens")]
    fn merges_cannot_follow_specials() {
        sample().push_merge(1, 2);
    }

    #[test]
    fn json_is_readable_with_one_merge_per_line() {
        let json = sample().to_json();
        assert!(json.starts_with("{\n  \"format\": \"bpe-tokenizer/v1\",\n"));
        assert!(json.contains("  \"pattern\": \"gpt4\",\n"));
        assert!(json.contains("  \"vocab_size\": 260,\n"));
        assert!(json.contains("    {\"id\": 257, \"pair\": [32, 256], \"token\": \" th\"},\n"));
        assert!(json.contains("\"token\": \"\\\\xE0\\\\xB0\"}"));
        assert!(json.contains("    {\"id\": 259, \"token\": \"<|endoftext|>\"}\n"));
        assert_eq!(Vocab::from_json(&json).unwrap(), sample());
    }

    #[test]
    fn json_round_trips_without_pattern_merges_or_specials() {
        let base = Vocab::byte_level();
        let json = base.to_json();
        assert!(json.contains("\"pattern\": null"));
        assert!(json.contains("\"merges\": []"));
        assert!(json.contains("\"special_tokens\": []"));
        assert_eq!(Vocab::from_json(&json).unwrap(), base);
    }

    #[test]
    fn save_and_load_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.json");
        sample().save(&path).unwrap();
        assert_eq!(Vocab::load(&path).unwrap(), sample());
        let missing = Vocab::load(dir.path().join("missing.json")).unwrap_err();
        assert!(matches!(missing, Error::Io(_)));
        assert!(std::error::Error::source(&missing).is_some());
        let not_dir = sample().save(dir.path().join("no/such/dir.json"));
        assert!(matches!(not_dir, Err(Error::Io(_))));
    }

    fn load_err(json: &str) -> String {
        Vocab::from_json(json).unwrap_err().to_string()
    }

    fn file(pattern: &str, merges: &str, specials: &str) -> String {
        format!(
            r#"{{"format": "bpe-tokenizer/v1", "pattern": {pattern}, "merges": [{merges}], "special_tokens": [{specials}]}}"#
        )
    }

    #[test]
    fn invalid_vocab_files_are_rejected_with_clear_errors() {
        let err = Vocab::from_json("not json").unwrap_err();
        assert!(matches!(err, Error::Json(_)));
        assert!(err.to_string().starts_with("vocab file is not valid JSON"));
        assert!(std::error::Error::source(&err).is_some());

        let wrong_format = file("null", "", "").replace("v1", "v9");
        assert!(load_err(&wrong_format).contains("unsupported format \"bpe-tokenizer/v9\""));
        assert!(load_err(&file("\"gpt5\"", "", "")).contains("unknown pattern \"gpt5\""));
        assert!(
            load_err(&file("null", r#"{"id": 300, "pair": [1, 2]}"#, ""))
                .contains("merge has id 300, expected 256")
        );
        assert!(
            load_err(&file("null", r#"{"id": 256, "pair": [1, 256]}"#, ""))
                .contains("does not exist yet: [1, 256]")
        );
        let twice = r#"{"id": 256, "pair": [1, 2]}, {"id": 257, "pair": [1, 2]}"#;
        assert!(load_err(&file("null", twice, "")).contains("pair [1, 2] is merged twice"));
        assert!(
            load_err(&file("null", "", r#"{"id": 999, "token": "<|x|>"}"#))
                .contains("special token \"<|x|>\" has id 999, expected 256")
        );
        assert!(
            load_err(&file("null", "", r#"{"id": 256, "token": ""}"#)).contains("cannot be empty")
        );
        let sized = file("null", "", "").replace("\"merges\"", "\"vocab_size\": 300, \"merges\"");
        assert_eq!(
            load_err(&sized),
            "invalid vocab file: vocab_size says 300 but the file defines 256 tokens"
        );
        assert!(std::error::Error::source(&Error::InvalidVocab("x".into())).is_none());
    }
}
