// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Device Registry — tracks all devices that have accessed the vault.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "device-registry.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeviceRegistry {
    pub devices: Vec<DeviceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceEntry {
    /// Unique device identifier (generated on first vault open)
    pub device_id: String,
    /// User-friendly device name
    pub device_name: String,
    /// OS: "macos", "windows", "linux", "ios", "android", "browser"
    pub os: String,
    /// Device type: "desktop", "mobile", "extension"
    pub device_type: String,
    /// First time this device accessed the vault
    pub first_seen: String,
    /// Last time this device accessed the vault
    pub last_seen: String,
    /// Whether biometric is enrolled on this device
    pub biometric_enrolled: bool,
    /// Last sync timestamp (if sync is enabled)
    pub last_synced: Option<String>,
    /// Whether this is the current device
    pub is_current: bool,
}

/// Register or update a device in the registry.
pub fn register_device(
    vault_dir: &Path,
    device_id: &str,
    device_name: &str,
    os: &str,
    device_type: &str,
) -> std::io::Result<()> {
    let mut registry: DeviceRegistry = InternalStore::read(vault_dir, FILENAME);
    let now = Utc::now().to_rfc3339();

    if let Some(existing) = registry
        .devices
        .iter_mut()
        .find(|d| d.device_id == device_id)
    {
        existing.last_seen = now;
        existing.device_name = device_name.to_string();
        existing.is_current = true;
    } else {
        registry.devices.push(DeviceEntry {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            os: os.to_string(),
            device_type: device_type.to_string(),
            first_seen: now.clone(),
            last_seen: now,
            biometric_enrolled: false,
            last_synced: None,
            is_current: true,
        });
    }

    // Mark all other devices as not current
    for device in &mut registry.devices {
        if device.device_id != device_id {
            device.is_current = false;
        }
    }

    InternalStore::write(vault_dir, FILENAME, &registry)
}

/// Get the device registry.
pub fn get_devices(vault_dir: &Path) -> Vec<DeviceEntry> {
    let registry: DeviceRegistry = InternalStore::read(vault_dir, FILENAME);
    registry.devices
}

/// Update biometric enrollment status for a device.
pub fn set_biometric_enrolled(
    vault_dir: &Path,
    device_id: &str,
    enrolled: bool,
) -> std::io::Result<()> {
    let mut registry: DeviceRegistry = InternalStore::read(vault_dir, FILENAME);
    if let Some(device) = registry
        .devices
        .iter_mut()
        .find(|d| d.device_id == device_id)
    {
        device.biometric_enrolled = enrolled;
    }
    InternalStore::write(vault_dir, FILENAME, &registry)
}

/// Update last sync timestamp for a device.
pub fn record_sync(vault_dir: &Path, device_id: &str) -> std::io::Result<()> {
    let mut registry: DeviceRegistry = InternalStore::read(vault_dir, FILENAME);
    if let Some(device) = registry
        .devices
        .iter_mut()
        .find(|d| d.device_id == device_id)
    {
        device.last_synced = Some(Utc::now().to_rfc3339());
    }
    InternalStore::write(vault_dir, FILENAME, &registry)
}

/// Remove a device from the registry.
pub fn remove_device(vault_dir: &Path, device_id: &str) -> std::io::Result<()> {
    let mut registry: DeviceRegistry = InternalStore::read(vault_dir, FILENAME);
    registry.devices.retain(|d| d.device_id != device_id);
    InternalStore::write(vault_dir, FILENAME, &registry)
}
