// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Diceware-style passphrase generation.
//!
//! Builds a passphrase by drawing whole words uniformly at random from a word
//! list (EFF diceware, 7776 words, or BIP-39, 2048 words) using the OS CSPRNG
//! (`ring::rand::SystemRandom`). Words can be capitalized and joined by an
//! arbitrary separator, and an optional digit may be appended to one random
//! word. Entropy is computed analytically as `word_count * log2(list_size)`
//! (plus ~3.32 bits when a digit is added) rather than measured, which is exact
//! because every word is chosen independently and uniformly.

use ring::rand::{SecureRandom, SystemRandom};

use super::{strength, GenerateResult, PassphraseOptions, WordList, BIP39_ENGLISH, EFF_DICEWARE};

/// Generate a passphrase by picking random words from a word list.
pub fn generate(opts: &PassphraseOptions) -> Result<GenerateResult, String> {
    let word_count = opts.word_count.clamp(3, 12);
    let list = match opts.word_list {
        WordList::Eff => EFF_DICEWARE,
        WordList::Bip39 => BIP39_ENGLISH,
    };

    let rng = SystemRandom::new();
    let mut words: Vec<String> = Vec::with_capacity(word_count);

    for _ in 0..word_count {
        let idx = random_index(&rng, list.len())?;
        let mut word = list[idx].to_string();
        if opts.capitalize {
            capitalize_first(&mut word);
        }
        words.push(word);
    }

    // Optionally append a digit to a random word
    if opts.include_number {
        let word_idx = random_index(&rng, words.len())?;
        let digit = random_index(&rng, 10)?;
        words[word_idx].push((b'0' + digit as u8) as char);
    }

    let value = words.join(&opts.separator);

    // Entropy: each word = log2(list_size), plus ~3.3 bits for the digit
    let mut entropy = word_count as f64 * (list.len() as f64).log2();
    if opts.include_number {
        entropy += (10_f64).log2();
    }

    let strength = strength::score(entropy);

    Ok(GenerateResult {
        value,
        entropy_bits: entropy,
        strength,
    })
}

fn capitalize_first(s: &mut String) {
    if let Some(first) = s.chars().next() {
        let rest: String = s.chars().skip(1).collect();
        *s = first.to_uppercase().to_string() + &rest;
    }
}

fn random_index(rng: &SystemRandom, max: usize) -> Result<usize, String> {
    if max == 0 {
        return Err("Cannot select from empty list".to_string());
    }
    // Use 4 bytes for larger ranges (word lists up to 7776)
    let mut buf = [0u8; 4];
    let limit = (u32::MAX as usize / max) * max;
    loop {
        rng.fill(&mut buf).map_err(|_| "RNG failure")?;
        let val = u32::from_le_bytes(buf) as usize;
        if val < limit {
            return Ok(val % max);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The EFF list contains hyphenated words (`drop-down`, `t-shirt`), so a
    /// `-` separator cannot be used to count words: the split overcounts in
    /// roughly one run in four hundred. `|` appears in no word on either list.
    #[test]
    fn generates_correct_word_count() {
        let result = generate(&PassphraseOptions {
            word_count: 5,
            separator: "|".to_string(),
            capitalize: false,
            include_number: false,
            word_list: WordList::Eff,
        })
        .unwrap();
        assert_eq!(result.value.split('|').count(), 5);
    }

    #[test]
    fn capitalizes_words() {
        let result = generate(&PassphraseOptions {
            word_count: 4,
            separator: " ".to_string(),
            capitalize: true,
            include_number: false,
            word_list: WordList::Eff,
        })
        .unwrap();
        for word in result.value.split(' ') {
            let first = word.chars().next().unwrap();
            assert!(first.is_uppercase(), "word '{word}' not capitalized");
        }
    }

    #[test]
    fn bip39_word_list() {
        let result = generate(&PassphraseOptions {
            word_count: 6,
            word_list: WordList::Bip39,
            ..Default::default()
        })
        .unwrap();
        assert!(!result.value.is_empty());
        // BIP-39 has 2048 words → ~11 bits/word
        let expected_min = 6.0 * (2048_f64).log2();
        assert!(result.entropy_bits >= expected_min - 0.01);
    }

    #[test]
    fn include_number_adds_digit() {
        // Run multiple times — digit should appear somewhere
        let mut found_digit = false;
        for _ in 0..20 {
            let result = generate(&PassphraseOptions {
                word_count: 4,
                separator: "-".to_string(),
                capitalize: false,
                include_number: true,
                word_list: WordList::Eff,
            })
            .unwrap();
            if result.value.chars().any(|c| c.is_ascii_digit()) {
                found_digit = true;
                break;
            }
        }
        assert!(found_digit, "no digit found after many attempts");
    }

    #[test]
    fn clamps_word_count() {
        let result = generate(&PassphraseOptions {
            word_count: 1,
            separator: "-".to_string(),
            capitalize: false,
            include_number: false,
            word_list: WordList::Eff,
        })
        .unwrap();
        // Clamped to 3
        assert_eq!(result.value.split('-').count(), 3);
    }
}
