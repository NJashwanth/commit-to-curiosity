//! GPT-style pre-tokenization: split text into words, numbers, punctuation
//! and whitespace before BPE runs, so merges never cross those boundaries.
//!
//! Without it, BPE happily learns tokens like `"e t"` or `"d, "` that glue
//! the end of one word to the start of the next. With it, a leading space
//! sticks to the following word (`" world"`) and everything else stays apart.

use fancy_regex::Regex;

/// GPT-2's split pattern (from OpenAI's `encoder.py`).
pub const GPT2_PATTERN: &str =
    r"'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+";

/// GPT-4's split pattern (`cl100k_base`): case-insensitive contractions,
/// numbers in groups of at most three digits, and newlines kept together.
pub const GPT4_PATTERN: &str = r"'(?i:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";

/// Which split pattern to use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    Gpt2,
    Gpt4,
}

impl Pattern {
    /// The regex source.
    pub fn source(self) -> &'static str {
        match self {
            Pattern::Gpt2 => GPT2_PATTERN,
            Pattern::Gpt4 => GPT4_PATTERN,
        }
    }

    /// Short name used in vocab files and on the command line.
    pub fn name(self) -> &'static str {
        match self {
            Pattern::Gpt2 => "gpt2",
            Pattern::Gpt4 => "gpt4",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "gpt2" => Some(Pattern::Gpt2),
            "gpt4" => Some(Pattern::Gpt4),
            _ => None,
        }
    }

    /// Compile the pattern. Both patterns are constants known to be valid.
    pub fn regex(self) -> Regex {
        Regex::new(self.source()).expect("built-in split pattern is valid")
    }
}

/// Split `text` into pieces using `re`. The pieces always concatenate back to
/// `text`: any text the regex skips over is kept as its own piece, and if the
/// regex engine gives up (backtracking limit), the rest is one piece.
pub fn split<'t>(re: &Regex, text: &'t str) -> Vec<&'t str> {
    let mut pieces = Vec::new();
    let mut last = 0;
    for found in re.find_iter(text) {
        let Ok(m) = found else { break };
        if m.start() > last {
            pieces.push(&text[last..m.start()]);
        }
        if m.end() > m.start() {
            pieces.push(m.as_str());
        }
        last = m.end();
    }
    if last < text.len() {
        pieces.push(&text[last..]);
    }
    pieces
}

/// A run of text, or one occurrence of a special token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Segment<'t> {
    Text(&'t str),
    Special(&'t str),
}

/// A regex matching any of the special tokens literally, longest first so
/// that `<|endoftext|>` wins over a shorter token that is a prefix of it.
/// `None` when there are no special tokens.
pub fn special_regex<S: AsRef<str>>(tokens: &[S]) -> Option<Regex> {
    if tokens.is_empty() {
        return None;
    }
    let mut sorted: Vec<&str> = tokens.iter().map(AsRef::as_ref).collect();
    sorted.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    let alternation: Vec<String> = sorted
        .iter()
        .map(|t| fancy_regex::escape(t).into_owned())
        .collect();
    Some(Regex::new(&alternation.join("|")).expect("escaped literals form a valid regex"))
}

/// Cut `text` around special tokens. Empty text runs are dropped.
pub fn split_specials<'t>(re: Option<&Regex>, text: &'t str) -> Vec<Segment<'t>> {
    let Some(re) = re else {
        return if text.is_empty() {
            vec![]
        } else {
            vec![Segment::Text(text)]
        };
    };
    let mut segments = Vec::new();
    let mut last = 0;
    // Literal alternations never backtrack, so matching cannot fail.
    for m in re.find_iter(text).flatten() {
        if m.start() > last {
            segments.push(Segment::Text(&text[last..m.start()]));
        }
        segments.push(Segment::Special(m.as_str()));
        last = m.end();
    }
    if last < text.len() {
        segments.push(Segment::Text(&text[last..]));
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpt4(text: &str) -> Vec<&str> {
        split(&Pattern::Gpt4.regex(), text)
    }

    fn gpt2(text: &str) -> Vec<&str> {
        split(&Pattern::Gpt2.regex(), text)
    }

    #[test]
    fn contractions_are_their_own_pieces() {
        assert_eq!(
            gpt4("I'm sure we'll go, they've said it's fine"),
            [
                "I", "'m", " sure", " we", "'ll", " go", ",", " they", "'ve", " said", " it", "'s",
                " fine"
            ]
        );
        assert_eq!(
            gpt4("can't you'd we're"),
            ["can", "'t", " you", "'d", " we", "'re"]
        );
    }

    #[test]
    fn gpt4_contractions_ignore_case_and_gpt2_does_not() {
        assert_eq!(gpt4("DON'T"), ["DON", "'T"]);
        assert_eq!(gpt2("DON'T"), ["DON", "'", "T"]);
        assert_eq!(gpt2("don't"), ["don", "'t"]);
    }

    #[test]
    fn numbers_split_into_groups_of_three_in_gpt4() {
        assert_eq!(gpt4("12345 1,000"), ["123", "45", " ", "1", ",", "000"]);
        assert_eq!(gpt2("12345 1,000"), ["12345", " 1", ",", "000"]);
        assert_eq!(gpt4("abc123"), ["abc", "123"]);
    }

    #[test]
    fn punctuation_and_words_stay_apart() {
        assert_eq!(
            gpt4("Hello, world!!! ...ok?"),
            ["Hello", ",", " world", "!!!", " ...", "ok", "?"]
        );
        assert_eq!(gpt4("(x)"), ["(x", ")"]);
        assert_eq!(gpt2("(x)"), ["(", "x", ")"]);
    }

    #[test]
    fn whitespace_runs_leave_one_space_for_the_next_word() {
        assert_eq!(gpt4("a   b"), ["a", "  ", " b"]);
        assert_eq!(gpt2("a   b"), ["a", "  ", " b"]);
        assert_eq!(gpt4("end  "), ["end", "  "]);
        assert_eq!(
            gpt4("line one\n\nline two\n"),
            ["line", " one", "\n\n", "line", " two", "\n"]
        );
        assert_eq!(gpt4("   "), ["   "]);
    }

    #[test]
    fn non_latin_scripts_and_emoji() {
        assert_eq!(gpt4("Hello 👋 world"), ["Hello", " 👋", " world"]);
        // Telugu vowel signs and the virama are Unicode marks (\p{M}), not
        // letters, so the GPT-4 pattern cuts a word at them.
        assert_eq!(gpt4("నమస్తే"), ["నమస", "్త", "ే"]);
        assert_eq!(gpt4("日本語 テキスト"), ["日本語", " テキスト"]);
    }

    #[test]
    fn pieces_always_concatenate_back_to_the_input() {
        for text in [
            "",
            "To be, or not to be: that is the question.",
            "Hello 👋 నమస్తే world\n\n\t 42 1234567 ...!?",
            "    leading and trailing    ",
            "\r\n\r\n",
            "x'y'z''",
        ] {
            for pieces in [gpt4(text), gpt2(text)] {
                assert_eq!(pieces.concat(), text);
                assert!(pieces.iter().all(|p| !p.is_empty()));
            }
        }
    }

    #[test]
    fn text_the_regex_skips_is_kept() {
        let re = Regex::new("a+").unwrap();
        assert_eq!(split(&re, "xxaayaz"), ["xx", "aa", "y", "a", "z"]);
        let empty_matches = Regex::new("b*").unwrap();
        assert_eq!(split(&empty_matches, "abba").concat(), "abba");
    }

    #[test]
    fn backtracking_limit_keeps_the_rest_as_one_piece() {
        let re = fancy_regex::RegexBuilder::new(r"(a+)+(?=b)")
            .backtrack_limit(10)
            .build()
            .unwrap();
        let text = format!("{}c done", "a".repeat(30));
        assert!(re.find(&text).is_err(), "the engine should hit its limit");
        let pieces = split(&re, &text);
        assert_eq!(pieces.concat(), text);
        assert_eq!(pieces, [text.as_str()]);
    }

    #[test]
    fn names_round_trip() {
        for p in [Pattern::Gpt2, Pattern::Gpt4] {
            assert_eq!(Pattern::from_name(p.name()), Some(p));
            assert!(!p.source().is_empty());
        }
        assert_eq!(Pattern::from_name("gpt5"), None);
    }

    #[test]
    fn special_tokens_are_cut_out_whole() {
        let re = special_regex(&["<|endoftext|>", "<|end|>"]).unwrap();
        use Segment::{Special, Text};
        assert_eq!(
            split_specials(Some(&re), "a<|endoftext|>b<|end|><|end|>"),
            [
                Text("a"),
                Special("<|endoftext|>"),
                Text("b"),
                Special("<|end|>"),
                Special("<|end|>")
            ]
        );
        assert_eq!(
            split_specials(Some(&re), "<|endoftext|>"),
            [Special("<|endoftext|>")]
        );
        assert_eq!(split_specials(Some(&re), "<|endof"), [Text("<|endof")]);
        assert_eq!(split_specials(Some(&re), ""), []);
        assert_eq!(split_specials(None, "x<|end|>"), [Text("x<|end|>")]);
        assert_eq!(split_specials(None, ""), []);
    }

    #[test]
    fn regex_metacharacters_in_special_tokens_are_literal() {
        let re = special_regex(&["[MASK]", "a.b"]).unwrap();
        assert_eq!(
            split_specials(Some(&re), "[MASK] axb a.b"),
            [
                Segment::Special("[MASK]"),
                Segment::Text(" axb "),
                Segment::Special("a.b")
            ]
        );
        assert!(special_regex::<&str>(&[]).is_none());
    }
}
