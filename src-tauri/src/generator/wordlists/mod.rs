// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Static word lists used by passphrase generation.
//!
//! Contains the two supported diceware-style lists as compile-time arrays:
//! [`bip39`] (the 2048-word BIP-39 English list) and [`eff_diceware`] (the EFF
//! "long" list of 7776 words). Both are fixed public data with no runtime
//! logic; the passphrase generator indexes into them with the OS CSPRNG.

pub mod bip39;
pub mod eff_diceware;
