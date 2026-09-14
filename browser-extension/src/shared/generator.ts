// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The extension's view of the shared generator.
 *
 * The algorithm, the character sets and the wordlists all live in
 * `@claspt/shared/generator`, which the mobile app uses too. This file is only
 * the shape adaptation: the extension's UI works in plain strings and its own
 * option names, while the shared functions return a `GenerateResult` and use
 * the Rust generator's field names.
 *
 * It used to be a second implementation of the whole thing, with its own
 * wordlist, so the same passphrase settings produced different results in the
 * extension and on the phone. Nothing about that was intentional.
 *
 * Randomness comes from Web Crypto, which the shared module picks up from
 * `globalThis` without needing to be told.
 */

import {
  analyzePassword,
  generateMemorable as sharedMemorable,
  generatePassphrase as sharedPassphrase,
  generatePassword as sharedPassword,
  generatePin as sharedPin,
  generateUuid as sharedUuid,
  EFF_WORDS,
  BIP39_WORDS,
  type MemorableOptions,
} from "@claspt/shared";

export type { MemorableOptions };

export interface PasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous?: boolean;
  excludeProblematic?: boolean;
  /**
   * Cap on how many symbol characters may appear in the result. Surplus symbol
   * positions are replaced with random non-symbol characters from the rest of
   * the active charset. Undefined = no cap.
   */
  maxSymbols?: number;
}

export interface PassphraseOptions {
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
  /** Which wordlist to draw from. Defaults to the EFF list. */
  wordList?: "eff" | "bip39";
}

export interface StrengthResult {
  score: number; // 0-4
  label: string; // "Weak", "Fair", "Good", "Strong", "Very Strong"
  entropy: number; // bits
  crackTime: string; // human-readable
}

export function generatePassword(opts: PasswordOptions): string {
  return sharedPassword({
    length: opts.length,
    uppercase: opts.uppercase,
    lowercase: opts.lowercase,
    numbers: opts.digits,
    special: opts.symbols,
    excludeAmbiguous: opts.excludeAmbiguous ?? false,
    excludeProblematic: opts.excludeProblematic ?? false,
    maxSymbols: opts.maxSymbols,
  }).value;
}

export function generatePassphrase(opts: PassphraseOptions): string {
  return sharedPassphrase(
    {
      wordCount: opts.wordCount,
      separator: opts.separator,
      capitalize: opts.capitalize,
      includeNumber: opts.includeNumber,
      wordList: opts.wordList ?? "eff",
    },
    EFF_WORDS,
    BIP39_WORDS,
  ).value;
}

export function generatePin(length: number): string {
  return sharedPin({ length }).value;
}

/** Pronounceable or pattern-based, the same two styles the phone offers. */
export function generateMemorable(opts: MemorableOptions): string {
  return sharedMemorable(opts).value;
}

export function generateUuid(): string {
  return sharedUuid().value;
}

export function estimateStrength(value: string): StrengthResult {
  const result = analyzePassword(value);
  return {
    score: result.score,
    label: result.label,
    entropy: Math.round(result.entropy_bits),
    crackTime: result.crack_time_display,
  };
}
