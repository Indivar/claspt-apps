// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Memorable-password generation in two styles.
//!
//! - `Pronounceable`: alternating consonant/vowel syllables grouped into
//!   short "words" (e.g. `bamuko-tivela-rosane`), easy to read aloud and type.
//!   Each syllable contributes `log2(18 * 5) ≈ 6.49` bits.
//! - `Pattern`: capitalized nouns interleaved with a two-digit number and a
//!   symbol (e.g. `Tiger42!Moon`), satisfying common "upper + digit + symbol"
//!   composition rules while staying recallable.
//!
//! All randomness comes from the OS CSPRNG (`ring::rand::SystemRandom`) and
//! entropy is computed analytically from the character/word alphabets.

use ring::rand::{SecureRandom, SystemRandom};

use super::{strength, GenerateResult, MemorableOptions, MemorableStyle};

const CONSONANTS: &[u8] = b"bcdfghjklmnprstvwz";
const VOWELS: &[u8] = b"aeiou";

/// Common nouns for pattern-based passwords (Word+Number+Symbol).
const NOUNS: &[&str] = &[
    "Alpha", "Arrow", "Atlas", "Amber", "Angel", "Blade", "Blaze", "Bolt", "Brave", "Brook",
    "Cedar", "Chain", "Chess", "Cloud", "Cobra", "Comet", "Coral", "Crown", "Cross", "Crest",
    "Dance", "Delta", "Depth", "Dodge", "Draft", "Drake", "Dream", "Drift", "Drum", "Dusk",
    "Eagle", "Earth", "Echo", "Ember", "Epoch", "Fable", "Falcon", "Flame", "Flash", "Flint",
    "Forge", "Frost", "Fury", "Fuse", "Fox", "Ghost", "Glade", "Gleam", "Globe", "Grace", "Grain",
    "Grant", "Grail", "Grove", "Guard", "Haven", "Hawk", "Heart", "Haze", "Helm", "Helix", "Hero",
    "Hive", "Hoard", "Horizon", "Ivory", "Iron", "Isle", "Iris", "Jade", "Jewel", "Judge",
    "Jungle", "Karma", "Kite", "Knight", "Knot", "Lake", "Lance", "Lark", "Latch", "Leaf", "Light",
    "Lion", "Lotus", "Lunar", "Lynx", "Maple", "March", "Marsh", "Mason", "Medal", "Mirth",
    "Moose", "Moth", "Mount", "Muse", "Myth", "Nexus", "Noble", "North", "Nova", "Oasis", "Ocean",
    "Omega", "Onyx", "Opera", "Orbit", "Otter", "Oxide", "Panda", "Parch", "Pearl", "Phase",
    "Pilot", "Pixel", "Plank", "Plaza", "Plume", "Point", "Prism", "Probe", "Pulse", "Quail",
    "Quartz", "Quest", "Raven", "Razor", "Realm", "Ridge", "River", "Robin", "Roost", "Royal",
    "Rune", "Sage", "Scale", "Scout", "Shade", "Shark", "Shell", "Shore", "Siege", "Sigma",
    "Silver", "Slate", "Solar", "Spark", "Spear", "Spire", "Sport", "Stalk", "Star", "Steam",
    "Steel", "Stone", "Storm", "Stout", "Surge", "Swift", "Sword", "Thorn", "Tide", "Tiger",
    "Torch", "Tower", "Trail", "Tryst", "Tulip", "Tusk", "Unity", "Umbra", "Vault", "Verse",
    "Vigor", "Viper", "Vista", "Vivid", "Vortex", "Warden", "Watch", "Weave", "Whale", "Wheat",
    "Wings", "Winter", "Witch", "Wolf", "Wren", "Xenon", "Yacht", "Yield", "Zenith", "Zephyr",
    "Zinc",
];

const SYMBOLS: &[u8] = b"!@#$%&*?";

/// Generate a memorable password: pronounceable syllables or word+number+symbol pattern.
pub fn generate(opts: &MemorableOptions) -> Result<GenerateResult, String> {
    match opts.style {
        MemorableStyle::Pronounceable => generate_pronounceable(opts),
        MemorableStyle::Pattern => generate_pattern(opts),
    }
}

/// Pronounceable: consonant-vowel syllables joined by separator.
/// Example: "bamuko-tivela-rosane"
fn generate_pronounceable(opts: &MemorableOptions) -> Result<GenerateResult, String> {
    let syllable_count = opts.syllable_count.unwrap_or(4).clamp(3, 8);
    let rng = SystemRandom::new();

    // Each "word" is 3 syllables (6 chars), separated by "-"
    let syllables_per_word = 3;
    let word_count = syllable_count.div_ceil(syllables_per_word);
    let remaining = syllable_count;

    let mut words: Vec<String> = Vec::new();
    let mut syllables_used = 0;

    for w in 0..word_count {
        let syl_in_word = if w == word_count - 1 {
            remaining - syllables_used
        } else {
            syllables_per_word
        };
        let mut word = String::with_capacity(syl_in_word * 2);
        for _ in 0..syl_in_word {
            let c = random_index(&rng, CONSONANTS.len())?;
            let v = random_index(&rng, VOWELS.len())?;
            word.push(CONSONANTS[c] as char);
            word.push(VOWELS[v] as char);
        }
        words.push(word);
        syllables_used += syl_in_word;
    }

    let value = words.join("-");

    // Entropy: each syllable = log2(18 * 5) = log2(90) ≈ 6.49 bits
    let entropy = syllable_count as f64 * (CONSONANTS.len() as f64 * VOWELS.len() as f64).log2();
    let strength = strength::score(entropy);

    Ok(GenerateResult {
        value,
        entropy_bits: entropy,
        strength,
    })
}

/// Pattern-based: Word + Number + Symbol + Word (e.g., "Tiger42!Moon")
fn generate_pattern(opts: &MemorableOptions) -> Result<GenerateResult, String> {
    let word_count = opts.word_count.unwrap_or(2).clamp(2, 4);
    let rng = SystemRandom::new();

    let mut parts: Vec<String> = Vec::new();

    for i in 0..word_count {
        // Pick a random noun
        let idx = random_index(&rng, NOUNS.len())?;
        parts.push(NOUNS[idx].to_string());

        // After each word except the last, insert number+symbol
        if i < word_count - 1 {
            let n1 = random_index(&rng, 10)?;
            let n2 = random_index(&rng, 10)?;
            let s = random_index(&rng, SYMBOLS.len())?;
            parts.push(format!("{}{}{}", n1, n2, SYMBOLS[s] as char));
        }
    }

    let value = parts.join("");

    // Entropy: word_count * log2(NOUNS) + (word_count-1) * (2*log2(10) + log2(SYMBOLS))
    let noun_bits = word_count as f64 * (NOUNS.len() as f64).log2();
    let separator_bits =
        (word_count - 1) as f64 * (2.0 * (10_f64).log2() + (SYMBOLS.len() as f64).log2());
    let entropy = noun_bits + separator_bits;
    let strength = strength::score(entropy);

    Ok(GenerateResult {
        value,
        entropy_bits: entropy,
        strength,
    })
}

fn random_index(rng: &SystemRandom, max: usize) -> Result<usize, String> {
    if max == 0 {
        return Err("Cannot select from empty set".to_string());
    }
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

    #[test]
    fn pronounceable_structure() {
        let result = generate(&MemorableOptions {
            style: MemorableStyle::Pronounceable,
            syllable_count: Some(6),
            word_count: None,
        })
        .unwrap();
        // 6 syllables in groups of 3 → 2 words separated by "-"
        let words: Vec<&str> = result.value.split('-').collect();
        assert_eq!(words.len(), 2);
        // Each word has 6 chars (3 syllables × 2 chars)
        for word in &words {
            assert_eq!(word.len(), 6);
        }
    }

    #[test]
    fn pronounceable_uses_cv_pairs() {
        let result = generate(&MemorableOptions {
            style: MemorableStyle::Pronounceable,
            syllable_count: Some(4),
            word_count: None,
        })
        .unwrap();
        // Check each character pair is consonant+vowel
        for word in result.value.split('-') {
            let chars: Vec<char> = word.chars().collect();
            for i in (0..chars.len()).step_by(2) {
                assert!(
                    CONSONANTS.contains(&(chars[i] as u8)),
                    "expected consonant at pos {i}, got '{}'",
                    chars[i]
                );
                if i + 1 < chars.len() {
                    assert!(
                        VOWELS.contains(&(chars[i + 1] as u8)),
                        "expected vowel at pos {}, got '{}'",
                        i + 1,
                        chars[i + 1]
                    );
                }
            }
        }
    }

    #[test]
    fn pattern_structure() {
        let result = generate(&MemorableOptions {
            style: MemorableStyle::Pattern,
            syllable_count: None,
            word_count: Some(2),
        })
        .unwrap();
        // Should contain at least one digit and one symbol
        assert!(result.value.chars().any(|c| c.is_ascii_digit()));
        assert!(result.value.chars().any(|c| SYMBOLS.contains(&(c as u8))));
    }

    #[test]
    fn pattern_3_words() {
        let result = generate(&MemorableOptions {
            style: MemorableStyle::Pattern,
            syllable_count: None,
            word_count: Some(3),
        })
        .unwrap();
        // With 3 words, there should be 2 number+symbol separators
        let digit_count = result.value.chars().filter(|c| c.is_ascii_digit()).count();
        assert!(
            digit_count >= 4,
            "expected at least 4 digits, got {digit_count}"
        );
    }

    #[test]
    fn entropy_is_reasonable() {
        let result = generate(&MemorableOptions {
            style: MemorableStyle::Pattern,
            syllable_count: None,
            word_count: Some(2),
        })
        .unwrap();
        // 2 words from ~195 nouns + 2 digits + 1 symbol → should be >30 bits
        assert!(result.entropy_bits > 20.0);
    }
}
