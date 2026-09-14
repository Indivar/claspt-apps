// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for generating passwords, passphrases, PINs, and UUIDs.
//!
//! These are thin command handlers invoked from the React frontend over Tauri's IPC
//! bridge. Each one delegates to the strategy-specific generators in the `generator`
//! module and returns a `GenerateResult` (or a plain value). Generators are pure and
//! stateless — they do not touch the vault or require it to be unlocked.
use crate::generator::{
    self, GenerateResult, MemorableOptions, PassphraseOptions, PasswordOptions, PinOptions,
    StrengthResult,
};

/// Generate a single random password from the given character-class/length options.
/// Returns the value plus strength metadata, or an error string if options are invalid.
#[tauri::command]
pub fn generate_password(options: PasswordOptions) -> Result<GenerateResult, String> {
    generator::password::generate(&options)
}

/// Generate a diceware-style passphrase (word list joined by a separator).
#[tauri::command]
pub fn generate_passphrase(options: PassphraseOptions) -> Result<GenerateResult, String> {
    generator::passphrase::generate(&options)
}

/// Generate a memorable, pronounceable password (alternating consonant/vowel patterns).
#[tauri::command]
pub fn generate_memorable(options: MemorableOptions) -> Result<GenerateResult, String> {
    generator::memorable::generate(&options)
}

/// Generate a numeric PIN of the requested length.
#[tauri::command]
pub fn generate_pin(options: PinOptions) -> Result<GenerateResult, String> {
    generator::pin::generate(&options)
}

/// Generate a random v4 UUID string.
#[tauri::command]
pub fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Analyze the strength of an existing password and return a scored result.
#[tauri::command]
pub fn check_password_strength(password: String) -> StrengthResult {
    generator::strength::analyze(&password)
}

/// Generate many values at once for the given generator type.
///
/// `gen_type` selects the strategy (`"password"`, `"passphrase"`, `"memorable"`, `"pin"`,
/// or `"uuid"`); `options_json` is the JSON-serialized options for that type; `count` is
/// clamped to the range 1..=1000. Returns the list of generated values, or an error string
/// if the type is unknown or the options JSON fails to parse.
#[tauri::command]
pub fn generate_bulk(
    gen_type: String,
    options_json: String,
    count: usize,
) -> Result<Vec<String>, String> {
    let count = count.clamp(1, 1000);

    let mut results = Vec::with_capacity(count);
    for _ in 0..count {
        let value = match gen_type.as_str() {
            "password" => {
                let opts: PasswordOptions =
                    serde_json::from_str(&options_json).map_err(|e| e.to_string())?;
                generator::password::generate(&opts)?.value
            }
            "passphrase" => {
                let opts: PassphraseOptions =
                    serde_json::from_str(&options_json).map_err(|e| e.to_string())?;
                generator::passphrase::generate(&opts)?.value
            }
            "memorable" => {
                let opts: MemorableOptions =
                    serde_json::from_str(&options_json).map_err(|e| e.to_string())?;
                generator::memorable::generate(&opts)?.value
            }
            "pin" => {
                let opts: PinOptions =
                    serde_json::from_str(&options_json).map_err(|e| e.to_string())?;
                generator::pin::generate(&opts)?.value
            }
            "uuid" => uuid::Uuid::new_v4().to_string(),
            _ => return Err(format!("Unknown generator type: {}", gen_type)),
        };
        results.push(value);
    }

    Ok(results)
}

/// Write a batch of previously generated values to a file.
///
/// `format` may be `"txt"` (newline-separated), `"csv"` (a single `value` column with
/// quotes escaped), or `"json"` (pretty-printed array). Returns an error string on an
/// unknown format or filesystem write failure.
#[tauri::command]
pub fn export_generated(
    values: Vec<String>,
    file_path: String,
    format: String,
) -> Result<(), String> {
    let content = match format.as_str() {
        "txt" => values.join("\n"),
        "csv" => {
            let mut out = String::from("value\n");
            for v in &values {
                // Escape quotes in CSV
                let escaped = v.replace('"', "\"\"");
                out.push('"');
                out.push_str(&escaped);
                out.push('"');
                out.push('\n');
            }
            out
        }
        "json" => serde_json::to_string_pretty(&values).map_err(|e| e.to_string())?,
        _ => return Err(format!("Unknown export format: {}", format)),
    };

    std::fs::write(&file_path, content).map_err(|e| e.to_string())
}
