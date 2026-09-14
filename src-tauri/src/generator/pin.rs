// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Numeric PIN generation.
//!
//! Produces a decimal PIN of 4–12 digits (the requested length is clamped into
//! that range) using the OS CSPRNG. Each digit is drawn by unbiased rejection
//! sampling over a single random byte, so every PIN of a given length is
//! equally likely. Entropy is `length * log2(10) ≈ 3.32` bits per digit.

use ring::rand::{SecureRandom, SystemRandom};

use super::{strength, GenerateResult, PinOptions};

/// Generate a numeric PIN using CSPRNG.
pub fn generate(opts: &PinOptions) -> Result<GenerateResult, String> {
    let length = opts.length.clamp(4, 12);
    let rng = SystemRandom::new();
    let mut result = String::with_capacity(length);

    for _ in 0..length {
        let digit = random_index(&rng, 10)?;
        result.push((b'0' + digit as u8) as char);
    }

    let entropy = length as f64 * (10_f64).log2();
    let strength = strength::score(entropy);

    Ok(GenerateResult {
        value: result,
        entropy_bits: entropy,
        strength,
    })
}

/// Rejection-sampling random index in [0, max).
fn random_index(rng: &SystemRandom, max: usize) -> Result<usize, String> {
    let limit = (256 / max) * max; // largest multiple of max ≤ 256
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
        for len in [4, 6, 8, 12] {
            let result = generate(&PinOptions { length: len }).unwrap();
            assert_eq!(result.value.len(), len);
            assert!(result.value.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn clamps_length() {
        let short = generate(&PinOptions { length: 2 }).unwrap();
        assert_eq!(short.value.len(), 4);
        let long = generate(&PinOptions { length: 20 }).unwrap();
        assert_eq!(long.value.len(), 12);
    }

    #[test]
    fn entropy_is_correct() {
        let result = generate(&PinOptions { length: 6 }).unwrap();
        let expected = 6.0 * (10_f64).log2();
        assert!((result.entropy_bits - expected).abs() < 0.01);
    }
}
