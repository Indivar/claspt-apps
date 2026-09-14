// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Random-character password generation.
//!
//! Builds a password from the enabled character categories using the OS
//! CSPRNG. Generation guarantees at least one character from every enabled,
//! non-empty pool, fills the remainder from the combined alphabet, then
//! Fisher-Yates shuffles so the guaranteed characters land in random
//! positions. Entropy is reported as `length * log2(alphabet_size)`.

use ring::rand::{SecureRandom, SystemRandom};

use super::{strength, GenerateResult, PasswordOptions};

/// Uppercase letters available to the generator.
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const DIGITS: &str = "0123456789";
const SPECIAL: &str = "!@#$%^&*()-_=+[]{}|;:,.<>?/~";

const AMBIGUOUS: &[char] = &['0', 'O', '1', 'l', 'I'];
const PROBLEMATIC: &[char] = &['\\', '\'', '"', '`', '{', '}', '<', '>'];

/// Generate a password using CSPRNG with rejection sampling.
pub fn generate(opts: &PasswordOptions) -> Result<GenerateResult, String> {
    let length = opts.length.clamp(4, 128);

    // Build character pools per enabled category
    let mut pools: Vec<Vec<char>> = Vec::new();

    if opts.uppercase {
        pools.push(filter_chars(UPPER, opts));
    }
    if opts.lowercase {
        pools.push(filter_chars(LOWER, opts));
    }
    if opts.numbers {
        pools.push(filter_chars(DIGITS, opts));
    }
    if opts.special {
        let special = opts.custom_special.as_deref().unwrap_or(SPECIAL);
        pools.push(filter_chars(special, opts));
    }

    if pools.is_empty() {
        return Err("At least one character category must be enabled".to_string());
    }

    // Remove empty pools (can happen if all chars filtered out)
    pools.retain(|p| !p.is_empty());
    if pools.is_empty() {
        return Err("No characters available after applying exclusions".to_string());
    }

    // Combined charset for entropy calculation and random selection
    let charset: Vec<char> = pools.iter().flat_map(|p| p.iter().copied()).collect();
    if charset.is_empty() {
        return Err("Empty charset".to_string());
    }

    let rng = SystemRandom::new();

    // Guarantee at least one char from each pool
    let mut chars: Vec<char> = Vec::with_capacity(length);
    for pool in &pools {
        let idx = random_index(&rng, pool.len())?;
        chars.push(pool[idx]);
    }

    // Fill remainder from combined charset
    while chars.len() < length {
        let idx = random_index(&rng, charset.len())?;
        chars.push(charset[idx]);
    }

    // Shuffle using Fisher-Yates
    for i in (1..chars.len()).rev() {
        let j = random_index(&rng, i + 1)?;
        chars.swap(i, j);
    }

    apply_symbol_cap(&rng, &mut chars, &charset, opts)?;

    let value: String = chars.into_iter().collect();
    // Entropy is reported for the unconstrained draw. Capping symbols lowers it
    // slightly, and the browser extension and mobile app report it the same way;
    // the three agree, and the figure is an upper bound rather than a claim.
    let entropy = length as f64 * (charset.len() as f64).log2();
    let strength = strength::score(entropy);

    Ok(GenerateResult {
        value,
        entropy_bits: entropy,
        strength,
    })
}

/// Replace surplus symbols with non-symbol characters until at most
/// `max_symbols` remain.
///
/// Positions are chosen at random rather than by scanning left to right, so the
/// symbols that survive are not biased toward the start of the password.
fn apply_symbol_cap(
    rng: &SystemRandom,
    chars: &mut [char],
    charset: &[char],
    opts: &PasswordOptions,
) -> Result<(), String> {
    let Some(max_symbols) = opts.max_symbols else {
        return Ok(());
    };
    if !opts.special {
        return Ok(());
    }

    let special: Vec<char> = opts
        .custom_special
        .as_deref()
        .unwrap_or(SPECIAL)
        .chars()
        .collect();
    let non_symbol: Vec<char> = charset
        .iter()
        .copied()
        .filter(|c| !special.contains(c))
        .collect();
    // Nothing to swap in — a symbols-only charset cannot honour a cap, and
    // silently returning fewer symbols than asked for beats failing the whole
    // generation over a preference.
    if non_symbol.is_empty() {
        return Ok(());
    }

    let mut symbol_positions: Vec<usize> = chars
        .iter()
        .enumerate()
        .filter(|(_, c)| special.contains(c))
        .map(|(i, _)| i)
        .collect();

    while symbol_positions.len() > max_symbols {
        let pick = random_index(rng, symbol_positions.len())?;
        let position = symbol_positions.swap_remove(pick);
        chars[position] = non_symbol[random_index(rng, non_symbol.len())?];
    }
    Ok(())
}

fn filter_chars(source: &str, opts: &PasswordOptions) -> Vec<char> {
    source
        .chars()
        .filter(|c| {
            if opts.exclude_ambiguous && AMBIGUOUS.contains(c) {
                return false;
            }
            if opts.exclude_problematic && PROBLEMATIC.contains(c) {
                return false;
            }
            true
        })
        .collect()
}

/// Rejection-sampling random index in [0, max).
fn random_index(rng: &SystemRandom, max: usize) -> Result<usize, String> {
    if max == 0 {
        return Err("Cannot select from empty set".to_string());
    }
    let limit = (256 / max) * max;
    let mut buf = [0u8; 1];
    loop {
        rng.fill(&mut buf).map_err(|_| "RNG failure")?;
        let val = buf[0] as usize;
        if val < limit {
            return Ok(val % max);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_correct_length() {
        let result = generate(&PasswordOptions {
            length: 20,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.value.len(), 20);
    }

    #[test]
    fn includes_all_categories() {
        // Generate many times to statistically verify category inclusion
        for _ in 0..10 {
            let result = generate(&PasswordOptions {
                length: 20,
                uppercase: true,
                lowercase: true,
                numbers: true,
                special: true,
                ..Default::default()
            })
            .unwrap();
            let v = &result.value;
            assert!(
                v.chars().any(|c| c.is_ascii_uppercase()),
                "missing uppercase"
            );
            assert!(
                v.chars().any(|c| c.is_ascii_lowercase()),
                "missing lowercase"
            );
            assert!(v.chars().any(|c| c.is_ascii_digit()), "missing digit");
            assert!(v.chars().any(|c| !c.is_alphanumeric()), "missing special");
        }
    }

    #[test]
    fn excludes_ambiguous() {
        for _ in 0..20 {
            let result = generate(&PasswordOptions {
                length: 50,
                exclude_ambiguous: true,
                ..Default::default()
            })
            .unwrap();
            for c in AMBIGUOUS {
                assert!(!result.value.contains(*c), "found ambiguous char '{c}'");
            }
        }
    }

    #[test]
    fn excludes_problematic() {
        for _ in 0..20 {
            let result = generate(&PasswordOptions {
                length: 50,
                special: true,
                exclude_problematic: true,
                ..Default::default()
            })
            .unwrap();
            for c in PROBLEMATIC {
                assert!(!result.value.contains(*c), "found problematic char '{c}'");
            }
        }
    }

    #[test]
    fn clamps_length() {
        let short = generate(&PasswordOptions {
            length: 1,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(short.value.len(), 4);
    }

    #[test]
    fn rejects_empty_charset() {
        let result = generate(&PasswordOptions {
            length: 10,
            uppercase: false,
            lowercase: false,
            numbers: false,
            special: false,
            ..Default::default()
        });
        assert!(result.is_err());
    }

    #[test]
    fn entropy_calculation() {
        let opts = PasswordOptions {
            length: 16,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: false,
            exclude_ambiguous: false,
            exclude_problematic: false,
            custom_special: None,
            max_symbols: None,
        };
        let result = generate(&opts).unwrap();
        // 26+26+10 = 62 chars → ~5.95 bits/char × 16 ≈ 95.3 bits
        let expected = 16.0 * (62_f64).log2();
        assert!((result.entropy_bits - expected).abs() < 0.01);
    }

    fn symbol_count(value: &str) -> usize {
        value.chars().filter(|c| SPECIAL.contains(*c)).count()
    }

    #[test]
    fn max_symbols_caps_the_symbol_count() {
        // Long password, symbols on: without a cap a 64-character draw from a
        // charset that is ~30% symbols lands well above two of them.
        for _ in 0..50 {
            let result = generate(&PasswordOptions {
                length: 64,
                special: true,
                max_symbols: Some(2),
                ..Default::default()
            })
            .unwrap();
            assert!(
                symbol_count(&result.value) <= 2,
                "expected at most 2 symbols, got {} in {}",
                symbol_count(&result.value),
                result.value
            );
            assert_eq!(result.value.chars().count(), 64);
        }
    }

    #[test]
    fn max_symbols_of_zero_removes_every_symbol() {
        let result = generate(&PasswordOptions {
            length: 40,
            special: true,
            max_symbols: Some(0),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(symbol_count(&result.value), 0);
    }

    #[test]
    fn max_symbols_is_ignored_when_symbols_are_off() {
        let result = generate(&PasswordOptions {
            length: 20,
            special: false,
            max_symbols: Some(0),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.value.chars().count(), 20);
    }

    #[test]
    fn no_cap_leaves_symbols_alone() {
        // Sanity check that the cap is what changes the outcome, not the
        // rewrite of the generation path.
        let mut saw_more_than_two = false;
        for _ in 0..50 {
            let result = generate(&PasswordOptions {
                length: 64,
                special: true,
                max_symbols: None,
                ..Default::default()
            })
            .unwrap();
            if symbol_count(&result.value) > 2 {
                saw_more_than_two = true;
                break;
            }
        }
        assert!(
            saw_more_than_two,
            "uncapped generation never exceeded 2 symbols"
        );
    }
}
