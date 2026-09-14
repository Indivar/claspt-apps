// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Secret generation and strength estimation.
//!
//! This module provides CSPRNG-based generation of random passwords,
//! diceware/BIP-39 passphrases, numeric PINs, and human-memorable passwords,
//! plus an entropy-based strength estimator shared by all of them. All
//! randomness comes from the operating system CSPRNG (`ring`'s
//! `SystemRandom`) via rejection sampling, so results are unbiased across the
//! chosen alphabet or word list. This top-level module defines the option
//! structs and result types exchanged with the frontend; the actual
//! generation logic lives in the `password`, `passphrase`, `memorable`, and
//! `pin` submodules, and scoring in `strength`.

pub mod memorable;
pub mod passphrase;
pub mod password;
pub mod pin;
pub mod strength;
mod wordlists;

pub use wordlists::bip39::BIP39_ENGLISH;
pub use wordlists::eff_diceware::EFF_DICEWARE;

use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────

/// Options controlling random-character password generation.
///
/// `length` is the desired character count; the generator clamps it to the
/// range 4..=128. The four category flags (`uppercase`, `lowercase`,
/// `numbers`, `special`) select which character pools are available, and at
/// least one enabled category must yield a non-empty pool or generation
/// fails. `exclude_ambiguous` drops visually confusable characters
/// (`0 O 1 l I`); `exclude_problematic` drops shell/markup-hostile characters
/// (`\ ' " ` { } < >`). `custom_special` overrides the default symbol set
/// when `special` is enabled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordOptions {
    /// Desired password length in characters; clamped to 4..=128.
    pub length: usize,
    /// Include uppercase letters `A–Z`. Defaults to `true`.
    #[serde(default = "default_true")]
    pub uppercase: bool,
    /// Include lowercase letters `a–z`. Defaults to `true`.
    #[serde(default = "default_true")]
    pub lowercase: bool,
    /// Include digits `0–9`. Defaults to `true`.
    #[serde(default = "default_true")]
    pub numbers: bool,
    /// Include special/symbol characters. Defaults to `false`.
    #[serde(default)]
    pub special: bool,
    /// Drop visually ambiguous characters (`0 O 1 l I`). Defaults to `false`.
    #[serde(default)]
    pub exclude_ambiguous: bool,
    /// Drop shell/markup-hostile characters (`\ ' " ` { } < >`). Defaults to `false`.
    #[serde(default)]
    pub exclude_problematic: bool,
    /// Custom symbol set to use instead of the default when `special` is enabled.
    #[serde(default)]
    pub custom_special: Option<String>,
    /// Cap on how many symbol characters may appear in the result.
    ///
    /// Surplus symbol positions are replaced with random non-symbol characters
    /// drawn from the rest of the active charset. `None` means no cap. Sites
    /// that accept symbols but choke on more than one or two are common enough
    /// that the mobile app and the browser extension both offer this; the
    /// desktop lacked it, so the same settings produced different passwords.
    #[serde(default)]
    pub max_symbols: Option<usize>,
}

/// Options controlling word-based passphrase generation.
///
/// `word_count` is the number of words to draw; the generator clamps it to
/// 3..=12. `separator` joins the words (default `-`). `capitalize`
/// title-cases each word, and `include_number` appends a single random digit
/// to one randomly chosen word. `word_list` selects between the EFF diceware
/// (7776 words) and BIP-39 (2048 words) lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PassphraseOptions {
    /// Number of words in the passphrase; clamped to 3..=12.
    pub word_count: usize,
    /// String inserted between words. Defaults to `-`.
    #[serde(default = "default_separator")]
    pub separator: String,
    /// Title-case the first letter of each word. Defaults to `false`.
    #[serde(default)]
    pub capitalize: bool,
    /// Append one random digit to a randomly chosen word. Defaults to `false`.
    #[serde(default)]
    pub include_number: bool,
    /// Which word list to draw from. Defaults to `Eff`.
    #[serde(default)]
    pub word_list: WordList,
}

/// Options controlling memorable-password generation.
///
/// `style` picks the generation strategy. For `Pronounceable`,
/// `syllable_count` (clamped to 3..=8, default 4) sets how many
/// consonant-vowel syllables are produced. For `Pattern`, `word_count`
/// (clamped to 2..=4, default 2) sets how many dictionary nouns are joined by
/// number+symbol groups. The field irrelevant to the chosen style is ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorableOptions {
    /// Generation strategy: pronounceable syllables or word/number/symbol pattern.
    #[serde(default)]
    pub style: MemorableStyle,
    /// Syllable count for `Pronounceable` style; clamped to 3..=8 (default 4).
    pub syllable_count: Option<usize>,
    /// Word count for `Pattern` style; clamped to 2..=4 (default 2).
    pub word_count: Option<usize>,
}

/// Options controlling numeric PIN generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinOptions {
    /// Number of digits in the PIN; clamped to 4..=12.
    pub length: usize,
}

/// A generated secret together with its computed strength metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateResult {
    /// The generated secret value (password, passphrase, PIN, etc.).
    pub value: String,
    /// Shannon entropy of the value in bits, derived from the generator's alphabet size.
    pub entropy_bits: f64,
    /// Strength scoring and human-readable feedback for `value`.
    pub strength: StrengthResult,
}

/// Strength assessment of a password, whether generated or user-entered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrengthResult {
    /// Estimated entropy in bits.
    pub entropy_bits: f64,
    /// Human-readable estimate of offline crack time (e.g. "3 years", "instant").
    pub crack_time_display: String,
    /// Coarse score bucket from 0 (Very Weak) to 4 (Very Strong).
    pub score: u8,
    /// Text label matching `score` (e.g. "Fair", "Strong").
    pub label: String,
    /// Actionable suggestions for improving weak passwords; empty when strong.
    pub suggestions: Vec<String>,
}

/// Word list used for passphrase generation.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WordList {
    /// EFF diceware list (7776 words, ~12.9 bits/word). The default.
    #[default]
    Eff,
    /// BIP-39 English list (2048 words, ~11 bits/word).
    Bip39,
}

/// Strategy for generating human-memorable passwords.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MemorableStyle {
    /// Consonant-vowel syllables joined by `-` (e.g. "bamuko-tivela"). The default.
    #[default]
    Pronounceable,
    /// Dictionary nouns joined by number+symbol groups (e.g. "Tiger42!Moon").
    Pattern,
}

// ── Defaults ───────────────────────────────────────────────────────

fn default_true() -> bool {
    true
}

fn default_separator() -> String {
    "-".to_string()
}

impl Default for PasswordOptions {
    fn default() -> Self {
        Self {
            length: 20,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: true,
            exclude_ambiguous: false,
            exclude_problematic: false,
            custom_special: None,
            max_symbols: None,
        }
    }
}

impl Default for PassphraseOptions {
    fn default() -> Self {
        Self {
            word_count: 5,
            separator: "-".to_string(),
            capitalize: true,
            include_number: false,
            word_list: WordList::Eff,
        }
    }
}

impl Default for MemorableOptions {
    fn default() -> Self {
        Self {
            style: MemorableStyle::Pronounceable,
            syllable_count: Some(4),
            word_count: Some(2),
        }
    }
}

impl Default for PinOptions {
    fn default() -> Self {
        Self { length: 6 }
    }
}
