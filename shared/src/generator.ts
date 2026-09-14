// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Password generator — the JavaScript port of the Rust generator, shared by the
 * browser extension and the mobile app.
 *
 * The desktop app generates in Rust and reaches it over IPC. The other two need
 * to work with the desktop closed — the extension's in-page generator runs on
 * any web page, and the phone has no desktop to ask — so they carry this port.
 * Having ONE port rather than two is the point of it living here: the extension
 * and mobile previously had separate implementations with different wordlists,
 * so the same settings produced different passphrases on each.
 *
 * RANDOMNESS. Every value comes from a platform CSPRNG, never `Math.random`.
 * The source is injected because the two platforms expose different ones: the
 * extension has Web Crypto on `globalThis`, React Native does not and uses
 * `expo-crypto`. Callers on a platform without Web Crypto MUST call
 * {@link setRandomSource} before generating; there is no fallback, because a
 * generator that silently degrades its randomness is worse than one that fails.
 */

/**
 * Fills `array` with cryptographically secure random values.
 *
 * Both `crypto.getRandomValues` and `expo-crypto`'s equivalent take any integer
 * typed array; the generator uses `Uint32Array` for uniform index selection and
 * `Uint8Array` for UUID bytes.
 */
export type RandomArray = Uint8Array | Uint32Array;
export type RandomFill = (array: RandomArray) => void;

const webCryptoFill: RandomFill | null =
  typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues
    ? (array) => {
        globalThis.crypto.getRandomValues(array);
      }
    : null;

let randomFill: RandomFill | null = webCryptoFill;

/**
 * Supply the platform CSPRNG. Required on React Native, where Web Crypto is
 * absent; the extension picks up `globalThis.crypto` on its own.
 */
export function setRandomSource(fill: RandomFill): void {
  randomFill = fill;
}

function fillRandomBytes(array: RandomArray): void {
  if (!randomFill) {
    throw new Error(
      "No cryptographic random source. Call setRandomSource() before generating.",
    );
  }
  randomFill(array);
}

// ── Types ──────────────────────────────────────────────────────────

export interface GenerateResult {
  value: string;
  entropy_bits: number;
  strength: StrengthResult;
}

export interface StrengthResult {
  entropy_bits: number;
  crack_time_display: string;
  score: number; // 0-4
  label: string;
  suggestions: string[];
}

export interface PasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  excludeAmbiguous: boolean;
  excludeProblematic: boolean;
  /**
   * Cap the number of symbol characters in the output. Excess symbol positions
   * are replaced with random non-symbol characters drawn from the rest of the
   * active charset. Set to a large value (e.g. 64) to effectively disable.
   * Default applied by the generator: no cap.
   */
  maxSymbols?: number;
}

export interface PassphraseOptions {
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
  wordList: "eff" | "bip39";
}

export interface MemorableOptions {
  style: "pronounceable" | "pattern";
  syllableCount: number;
  wordCount: number;
}

export interface PinOptions {
  length: number;
}

// ── Constants ──────────────────────────────────────────────────────

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SPECIAL = "!@#$%^&*()-_=+[]{}|;:,.<>?/~";
const AMBIGUOUS = new Set(["0", "O", "1", "l", "I"]);
const PROBLEMATIC = new Set(["\\", "'", '"', "`", "{", "}", "<", ">"]);

const CONSONANTS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
const SYMBOLS = "!@#$%&*?";
const NOUNS = [
  "Alpha","Arrow","Atlas","Amber","Angel","Blade","Blaze","Bolt","Brave","Brook",
  "Cedar","Chain","Chess","Cloud","Cobra","Comet","Coral","Crown","Cross","Crest",
  "Dance","Delta","Depth","Dodge","Draft","Drake","Dream","Drift","Drum","Dusk",
  "Eagle","Earth","Echo","Ember","Epoch","Fable","Falcon","Flame","Flash","Flint",
  "Forge","Frost","Fury","Fuse","Fox","Ghost","Glade","Gleam","Globe","Grace","Grain",
  "Grant","Grail","Grove","Guard","Haven","Hawk","Heart","Haze","Helm","Helix","Hero",
  "Hive","Hoard","Horizon","Ivory","Iron","Isle","Iris","Jade","Jewel","Judge",
  "Jungle","Karma","Kite","Knight","Knot","Lake","Lance","Lark","Latch","Leaf","Light",
  "Lion","Lotus","Lunar","Lynx","Maple","March","Marsh","Mason","Medal","Mirth",
  "Moose","Moth","Mount","Muse","Myth","Nexus","Noble","North","Nova","Oasis","Ocean",
  "Omega","Onyx","Opera","Orbit","Otter","Oxide","Panda","Parch","Pearl","Phase",
  "Pilot","Pixel","Plank","Plaza","Plume","Point","Prism","Probe","Pulse","Quail",
  "Quartz","Quest","Raven","Razor","Realm","Ridge","River","Robin","Roost","Royal",
  "Rune","Sage","Scale","Scout","Shade","Shark","Shell","Shore","Siege","Sigma",
  "Silver","Slate","Solar","Spark","Spear","Spire","Sport","Stalk","Star","Steam",
  "Steel","Stone","Storm","Stout","Surge","Swift","Sword","Thorn","Tide","Tiger",
  "Torch","Tower","Trail","Tryst","Tulip","Tusk","Unity","Umbra","Vault","Verse",
  "Vigor","Viper","Vista","Vivid","Vortex","Warden","Watch","Weave","Whale","Wheat",
  "Wings","Winter","Witch","Wolf","Wren","Xenon","Yacht","Yield","Zenith","Zephyr",
  "Zinc",
];

// ── CSPRNG ─────────────────────────────────────────────────────────

/** Rejection-sampling random index in [0, max) using expo-crypto. */
function randomIndex(max: number): number {
  if (max <= 0) throw new Error("Cannot select from empty set");
  const arr = new Uint32Array(1);
  const limit = Math.floor(0xFFFFFFFF / max) * max;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    fillRandomBytes(arr);
    const draw = arr[0] ?? 0;
    if (draw < limit) return draw % max;
  }
}

/**
 * Pick a uniformly random element. Separate from `arr[randomIndex(...)]` so the
 * empty case fails loudly rather than putting `undefined` into a password.
 */
function pick<T>(items: readonly T[]): T;
function pick(items: string): string;
function pick(items: readonly unknown[] | string): unknown {
  const index = randomIndex(items.length);
  const value = typeof items === "string" ? items.charAt(index) : items[index];
  if (value === undefined || value === "") {
    throw new Error("Cannot pick from an empty set");
  }
  return value;
}

/** Fisher-Yates shuffle in-place. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) continue;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

// ── Strength ───────────────────────────────────────────────────────

const GUESSES_PER_SEC = 1e12;

function entropyToScore(entropy: number): [number, string] {
  if (entropy < 28) return [0, "Very Weak"];
  if (entropy < 36) return [1, "Weak"];
  if (entropy < 60) return [2, "Fair"];
  if (entropy < 100) return [3, "Strong"];
  return [4, "Very Strong"];
}

function crackTimeDisplay(entropy: number): string {
  if (entropy <= 0) return "instant";
  const seconds = Math.pow(2, entropy) / GUESSES_PER_SEC / 2;
  if (seconds < 1) return "instant";
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  const days = seconds / 86400;
  if (days < 365.25) return `${Math.round(days)} days`;
  const years = days / 365.25;
  if (years < 100) return `${Math.round(years)} years`;
  if (years < 1_000_000) return `${Math.round(years / 100)} centuries`;
  return "centuries";
}

export function scoreEntropy(entropy: number): StrengthResult {
  const [score, label] = entropyToScore(entropy);
  const suggestions: string[] = [];
  if (score <= 1) suggestions.push("Add more characters or use a passphrase");
  if (entropy < 40) suggestions.push("Consider using at least 12 characters");
  if (score <= 2) suggestions.push("Mix uppercase, lowercase, numbers, and symbols");
  return {
    entropy_bits: entropy,
    crack_time_display: crackTimeDisplay(entropy),
    score,
    label,
    suggestions,
  };
}

/** Analyze a manually-entered password's strength. */
export function analyzePassword(password: string): StrengthResult {
  if (!password) return scoreEntropy(0);
  let charsetSize = 0;
  if (/[a-z]/.test(password)) charsetSize += 26;
  if (/[A-Z]/.test(password)) charsetSize += 26;
  if (/[0-9]/.test(password)) charsetSize += 10;
  if (/[^\w\s]/.test(password)) charsetSize += 32;
  if (/[^\x00-\x7F]/.test(password)) charsetSize += 64;
  if (charsetSize === 0) charsetSize = 26;
  let entropy = password.length * Math.log2(charsetSize);
  // Penalty for repeated chars
  let repeats = 0;
  for (let i = 1; i < password.length; i++) {
    if (password[i] === password[i - 1]) repeats++;
  }
  entropy = Math.max(0, entropy - repeats * 3);
  return scoreEntropy(entropy);
}

// ── Generators ─────────────────────────────────────────────────────

export function generatePassword(opts: PasswordOptions): GenerateResult {
  const length = Math.min(128, Math.max(4, opts.length));
  const pools: string[][] = [];

  const filter = (source: string) =>
    [...source].filter(
      (c) =>
        !(opts.excludeAmbiguous && AMBIGUOUS.has(c)) &&
        !(opts.excludeProblematic && PROBLEMATIC.has(c)),
    );

  if (opts.uppercase) pools.push(filter(UPPER));
  if (opts.lowercase) pools.push(filter(LOWER));
  if (opts.numbers) pools.push(filter(DIGITS));
  if (opts.special) pools.push(filter(SPECIAL));

  const validPools = pools.filter((p) => p.length > 0);
  if (validPools.length === 0) throw new Error("At least one character category must be enabled");

  const charset = validPools.flat();
  const chars: string[] = [];

  // Guarantee at least one from each pool
  for (const pool of validPools) {
    chars.push(pick(pool));
  }
  // Fill remainder
  while (chars.length < length) {
    chars.push(pick(charset));
  }
  shuffle(chars);

  // Enforce the max-symbols cap: replace surplus symbol positions with random
  // non-symbol characters from the rest of the active charset.
  //
  // The reported entropy below is for the unconstrained draw, so a capped
  // password's true entropy is slightly lower. The Rust generator reports it the
  // same way, so all three platforms agree and the figure is an upper bound
  // rather than a claim.
  const cap = opts.maxSymbols;
  if (opts.special && typeof cap === "number" && cap >= 0) {
    const symbolFiltered = filter(SPECIAL);
    const symbolSet = new Set(symbolFiltered);
    const nonSymbol = charset.filter((c) => !symbolSet.has(c));
    if (nonSymbol.length > 0) {
      // Walk a randomised order of indices so we don't always shave from the
      // start; that keeps symbol positions visually distributed.
      const order = chars.map((_, i) => i);
      shuffle(order);
      let symbolCount = chars.filter((c) => symbolSet.has(c)).length;
      for (const idx of order) {
        if (symbolCount <= cap) break;
        const current = chars[idx];
        if (current !== undefined && symbolSet.has(current)) {
          chars[idx] = pick(nonSymbol);
          symbolCount--;
        }
      }
    }
  }

  const entropy = length * Math.log2(charset.length);
  return { value: chars.join(""), entropy_bits: entropy, strength: scoreEntropy(entropy) };
}

export function generatePassphrase(
  opts: PassphraseOptions,
  effList: string[],
  bip39List: string[],
): GenerateResult {
  const wordCount = Math.min(12, Math.max(3, opts.wordCount));
  const list = opts.wordList === "bip39" ? bip39List : effList;

  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    let word = pick(list);
    if (opts.capitalize) word = word.charAt(0).toUpperCase() + word.slice(1);
    words.push(word);
  }

  if (opts.includeNumber) {
    const wi = randomIndex(words.length);
    words[wi] += String(randomIndex(10));
  }

  let entropy = wordCount * Math.log2(list.length);
  if (opts.includeNumber) entropy += Math.log2(10);

  return { value: words.join(opts.separator), entropy_bits: entropy, strength: scoreEntropy(entropy) };
}

export function generateMemorable(opts: MemorableOptions): GenerateResult {
  if (opts.style === "pronounceable") {
    const syllableCount = Math.min(8, Math.max(3, opts.syllableCount));
    const syllablesPerWord = 3;
    const wordCount = Math.ceil(syllableCount / syllablesPerWord);
    const words: string[] = [];
    let used = 0;

    for (let w = 0; w < wordCount; w++) {
      const count = w === wordCount - 1 ? syllableCount - used : syllablesPerWord;
      let word = "";
      for (let s = 0; s < count; s++) {
        word += pick(CONSONANTS);
        word += pick(VOWELS);
      }
      words.push(word);
      used += count;
    }

    const entropy = syllableCount * Math.log2(CONSONANTS.length * VOWELS.length);
    return { value: words.join("-"), entropy_bits: entropy, strength: scoreEntropy(entropy) };
  }

  // Pattern style: Word42!Word
  const wordCount = Math.min(4, Math.max(2, opts.wordCount));
  const parts: string[] = [];

  for (let i = 0; i < wordCount; i++) {
    parts.push(pick(NOUNS));
    if (i < wordCount - 1) {
      const n1 = randomIndex(10);
      const n2 = randomIndex(10);
      const s = pick(SYMBOLS);
      parts.push(`${n1}${n2}${s}`);
    }
  }

  const nounBits = wordCount * Math.log2(NOUNS.length);
  const sepBits = (wordCount - 1) * (2 * Math.log2(10) + Math.log2(SYMBOLS.length));
  const entropy = nounBits + sepBits;
  return { value: parts.join(""), entropy_bits: entropy, strength: scoreEntropy(entropy) };
}

export function generatePin(opts: PinOptions): GenerateResult {
  const length = Math.min(12, Math.max(4, opts.length));
  let value = "";
  for (let i = 0; i < length; i++) {
    value += String(randomIndex(10));
  }
  const entropy = length * Math.log2(10);
  return { value, entropy_bits: entropy, strength: scoreEntropy(entropy) };
}

export function generateUuid(): GenerateResult {
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { value, entropy_bits: 122, strength: scoreEntropy(122) };
}
