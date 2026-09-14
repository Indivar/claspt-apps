// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Password-strength scoring and crack-time estimation.
//!
//! Two entry points: [`score`] takes a known exact entropy (used for passwords
//! this crate generated) and [`analyze`] estimates entropy for an arbitrary
//! user-typed password from its character classes, with penalties for repeated
//! characters and sequential digit/letter runs. Both map entropy to a 0–4
//! score with a label and a human-readable crack-time string, assuming an
//! offline attacker at `GUESSES_PER_SEC`.

use super::StrengthResult;

/// Assumed offline attack speed: 10^12 guesses/second (modern GPU cluster).
const GUESSES_PER_SEC: f64 = 1e12;

/// Score a password by exact entropy (for generated passwords).
pub fn score(entropy_bits: f64) -> StrengthResult {
    let (score, label) = entropy_to_score(entropy_bits);
    let crack_time = crack_time_display(entropy_bits);
    let suggestions = suggestions_for(entropy_bits, score);

    StrengthResult {
        entropy_bits,
        crack_time_display: crack_time,
        score,
        label: label.to_string(),
        suggestions,
    }
}

/// Analyze a manually-entered password (unknown generation method).
/// Uses character-class analysis since we can't know the charset.
pub fn analyze(password: &str) -> StrengthResult {
    let entropy = estimate_entropy(password);
    score(entropy)
}

/// Estimate entropy of an arbitrary password via character-class analysis.
fn estimate_entropy(password: &str) -> f64 {
    if password.is_empty() {
        return 0.0;
    }

    // Determine effective charset size from character classes present
    let mut charset_size: usize = 0;
    let has_lower = password.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = password.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    let has_symbol = password.chars().any(|c| c.is_ascii_punctuation());
    let has_other = !password.is_ascii();

    if has_lower {
        charset_size += 26;
    }
    if has_upper {
        charset_size += 26;
    }
    if has_digit {
        charset_size += 10;
    }
    if has_symbol {
        charset_size += 32;
    }
    if has_other {
        charset_size += 64; // conservative estimate for unicode
    }

    if charset_size == 0 {
        charset_size = 26; // fallback: at least lowercase
    }

    let base_entropy = password.len() as f64 * (charset_size as f64).log2();

    // Apply penalties for sequential/repeated patterns
    let penalty = pattern_penalty(password);

    (base_entropy - penalty).max(0.0)
}

/// Penalize sequential digits, repeated chars, keyboard patterns.
fn pattern_penalty(password: &str) -> f64 {
    let chars: Vec<char> = password.chars().collect();
    let mut penalty = 0.0;

    // Repeated characters penalty
    let mut repeat_count = 0;
    for i in 1..chars.len() {
        if chars[i] == chars[i - 1] {
            repeat_count += 1;
        }
    }
    penalty += repeat_count as f64 * 3.0;

    // Sequential digits penalty (123, 987, etc.)
    let mut seq_count = 0;
    for i in 2..chars.len() {
        if chars[i].is_ascii_digit()
            && chars[i - 1].is_ascii_digit()
            && chars[i - 2].is_ascii_digit()
        {
            let a = chars[i - 2] as i32;
            let b = chars[i - 1] as i32;
            let c = chars[i] as i32;
            if (b - a == 1 && c - b == 1) || (a - b == 1 && b - c == 1) {
                seq_count += 1;
            }
        }
    }
    penalty += seq_count as f64 * 5.0;

    // Sequential letters penalty (abc, cba)
    for i in 2..chars.len() {
        if chars[i].is_ascii_alphabetic()
            && chars[i - 1].is_ascii_alphabetic()
            && chars[i - 2].is_ascii_alphabetic()
        {
            let a = chars[i - 2].to_ascii_lowercase() as i32;
            let b = chars[i - 1].to_ascii_lowercase() as i32;
            let c = chars[i].to_ascii_lowercase() as i32;
            if (b - a == 1 && c - b == 1) || (a - b == 1 && b - c == 1) {
                penalty += 5.0;
            }
        }
    }

    penalty
}

fn entropy_to_score(entropy: f64) -> (u8, &'static str) {
    if entropy < 28.0 {
        (0, "Very Weak")
    } else if entropy < 36.0 {
        (1, "Weak")
    } else if entropy < 60.0 {
        (2, "Fair")
    } else if entropy < 100.0 {
        (3, "Strong")
    } else {
        (4, "Very Strong")
    }
}

fn crack_time_display(entropy: f64) -> String {
    if entropy <= 0.0 {
        return "instant".to_string();
    }

    // 2^entropy / guesses_per_sec = seconds to exhaust keyspace
    // Average: half that
    let seconds = 2_f64.powf(entropy) / GUESSES_PER_SEC / 2.0;

    if seconds < 1.0 {
        "instant".to_string()
    } else if seconds < 60.0 {
        format!("{:.0} seconds", seconds)
    } else if seconds < 3600.0 {
        format!("{:.0} minutes", seconds / 60.0)
    } else if seconds < 86400.0 {
        format!("{:.0} hours", seconds / 3600.0)
    } else if seconds < 86400.0 * 365.25 {
        format!("{:.0} days", seconds / 86400.0)
    } else if seconds < 86400.0 * 365.25 * 100.0 {
        format!("{:.0} years", seconds / (86400.0 * 365.25))
    } else if seconds < 86400.0 * 365.25 * 1_000_000.0 {
        format!("{:.0} centuries", seconds / (86400.0 * 365.25 * 100.0))
    } else {
        "centuries".to_string()
    }
}

fn suggestions_for(entropy: f64, score: u8) -> Vec<String> {
    let mut suggestions = Vec::new();

    if score <= 1 {
        suggestions.push("Add more characters or use a passphrase".to_string());
    }
    if entropy < 40.0 {
        suggestions.push("Consider using at least 12 characters".to_string());
    }
    if score <= 2 {
        suggestions.push("Mix uppercase, lowercase, numbers, and symbols".to_string());
    }

    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_ranges() {
        assert_eq!(score(10.0).score, 0);
        assert_eq!(score(10.0).label, "Very Weak");
        assert_eq!(score(30.0).score, 1);
        assert_eq!(score(30.0).label, "Weak");
        assert_eq!(score(50.0).score, 2);
        assert_eq!(score(50.0).label, "Fair");
        assert_eq!(score(80.0).score, 3);
        assert_eq!(score(80.0).label, "Strong");
        assert_eq!(score(120.0).score, 4);
        assert_eq!(score(120.0).label, "Very Strong");
    }

    #[test]
    fn crack_time_ranges() {
        assert_eq!(crack_time_display(0.0), "instant");
        // 40 bits at 10^12/sec → ~0.0005s → instant
        assert_eq!(crack_time_display(40.0), "instant");
        // 60 bits → ~576k seconds → ~6.7 days
        let t60 = crack_time_display(60.0);
        assert!(
            t60.contains("days") || t60.contains("hours"),
            "60 bits: {t60}"
        );
        // 80 bits → ~19k years
        let t80 = crack_time_display(80.0);
        assert!(
            t80.contains("years") || t80.contains("centuries"),
            "80 bits: {t80}"
        );
        assert!(crack_time_display(200.0).contains("centuries"));
    }

    #[test]
    fn analyze_empty() {
        let result = analyze("");
        assert_eq!(result.score, 0);
        assert_eq!(result.entropy_bits, 0.0);
    }

    #[test]
    fn analyze_weak_password() {
        let result = analyze("1234");
        assert!(result.score <= 1);
    }

    #[test]
    fn analyze_strong_password() {
        let result = analyze("K$9mX#pL2!vQ8@nR");
        assert!(result.score >= 3);
    }

    #[test]
    fn penalty_for_repeats() {
        // Use strings where only repeats differ (no sequential letter penalties)
        let plain = estimate_entropy("kwpxmzjr");
        let repeated = estimate_entropy("aaabbbcc");
        assert!(
            repeated < plain,
            "repeated chars should have lower entropy: plain={plain}, repeated={repeated}"
        );
    }

    #[test]
    fn penalty_for_sequences() {
        let random = estimate_entropy("k8m3p7q2");
        let sequential = estimate_entropy("12345678");
        assert!(
            sequential < random,
            "sequential digits should have lower entropy"
        );
    }

    #[test]
    fn suggestions_present_for_weak() {
        let result = score(20.0);
        assert!(!result.suggestions.is_empty());
    }

    #[test]
    fn no_suggestions_for_strong() {
        let result = score(120.0);
        assert!(result.suggestions.is_empty());
    }
}
