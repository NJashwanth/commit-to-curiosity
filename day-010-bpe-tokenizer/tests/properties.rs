//! Property tests: invariants that must hold for any input, not just the
//! examples in the unit tests.

use std::sync::OnceLock;

use bpe_tokenizer::pretokenize::{self, Pattern};
use bpe_tokenizer::{Tokenizer, TrainOptions, Vocab, train};
use proptest::prelude::*;

const EOT: &str = "<|endoftext|>";

const CORPUS: &str = "First Citizen: Before we proceed any further, hear me speak.\n\
    All: Speak, speak. You are all resolved rather to die than to famish?\n\
    Hello 👋 world! నమస్తే ప్రపంచం, ఎలా ఉన్నారు? 🎉🎉 naïve café 日本語のテキスト 123 4567.\n\
    It's what we'll do; they've said I'm sure you'd agree.\n";

/// Tokenizers for each pre-tokenization mode, trained once and shared.
fn tokenizers() -> &'static [Tokenizer] {
    static TOKS: OnceLock<Vec<Tokenizer>> = OnceLock::new();
    TOKS.get_or_init(|| {
        let text = format!("{CORPUS}{EOT}").repeat(4);
        [Some(Pattern::Gpt4), Some(Pattern::Gpt2), None]
            .into_iter()
            .map(|pattern| {
                let opts = TrainOptions {
                    vocab_size: 600,
                    pattern,
                    special_tokens: vec![EOT.into()],
                    progress: false,
                };
                Tokenizer::new(train(&text, &opts).unwrap().0)
            })
            .collect()
    })
}

/// Strings that mix the scripts the tokenizers were trained on.
fn mixed_text() -> impl Strategy<Value = String> {
    "(\\p{Telugu}|\\p{Han}|[ a-zA-Z0-9.,'!?\\n\\t]|👋|🎉|speak| the|<\\|endoftext\\|>){0,40}"
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn decode_of_encode_is_identity(s in any::<String>()) {
        for tok in tokenizers() {
            let decoded = tok.decode(&tok.encode(&s)).unwrap();
            prop_assert_eq!(&decoded.text, &s);
            prop_assert!(!decoded.lossy);
            prop_assert_eq!(tok.decode(&tok.encode_ordinary(&s)).unwrap().text, s.clone());
        }
    }

    #[test]
    fn decode_of_encode_is_identity_for_mixed_scripts(s in mixed_text()) {
        for tok in tokenizers() {
            let ids = tok.encode(&s);
            prop_assert!(ids.len() <= s.len(), "never more tokens than bytes");
            prop_assert_eq!(tok.decode(&ids).unwrap().text, s.clone());
        }
    }

    #[test]
    fn special_tokens_are_atomic(parts in prop::collection::vec("[^<]{0,12}", 1..6)) {
        let text = parts.join(EOT);
        for tok in tokenizers() {
            let eot = tok.vocab().special_id(EOT).unwrap();
            let ids = tok.encode(&text);
            let found = ids.iter().filter(|&&id| id == eot).count();
            prop_assert_eq!(found, parts.len() - 1);
            prop_assert!(!tok.encode_ordinary(&text).contains(&eot));
        }
    }

    #[test]
    fn tokens_never_cross_pre_token_boundaries(s in mixed_text()) {
        let tok = &tokenizers()[0];
        let re = Pattern::Gpt4.regex();
        let ids = tok.encode_ordinary(&s);
        let mut ends = std::collections::HashSet::new();
        let mut end = 0;
        for &id in &ids {
            end += tok.vocab().token_bytes(id).unwrap().len();
            ends.insert(end);
        }
        let mut boundary = 0;
        for piece in pretokenize::split(&re, &s) {
            boundary += piece.len();
            prop_assert!(ends.contains(&boundary));
        }
    }

    #[test]
    fn saved_and_loaded_vocabs_encode_identically(s in mixed_text()) {
        for tok in tokenizers() {
            let loaded = Tokenizer::new(Vocab::from_json(&tok.vocab().to_json()).unwrap());
            prop_assert_eq!(loaded.encode(&s), tok.encode(&s));
        }
    }

    #[test]
    fn training_is_deterministic_and_round_trips(
        corpus in "[ab c\\n]{0,80}",
        extra in 0usize..60,
        split in any::<bool>(),
    ) {
        let opts = TrainOptions {
            vocab_size: 256 + extra,
            pattern: split.then_some(Pattern::Gpt4),
            ..Default::default()
        };
        let (first, _) = train(&corpus, &opts).unwrap();
        let (second, _) = train(&corpus, &opts).unwrap();
        prop_assert_eq!(&first, &second);
        let tok = Tokenizer::new(first);
        prop_assert_eq!(tok.decode(&tok.encode(&corpus)).unwrap().text, corpus);
    }

    #[test]
    fn decoding_unknown_ids_fails(offset in 0u32..1000) {
        let tok = &tokenizers()[0];
        let bad = tok.vocab().len() as u32 + offset;
        prop_assert!(tok.decode(&[104, bad]).is_err());
    }
}
