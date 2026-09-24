// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * @claspt/shared — the barrel entry for types/constants shared by the desktop
 * (Tauri/React) and mobile (React Native) apps.
 *
 * Consumers import from the package root (`@claspt/shared/...`); this file
 * re-exports every public symbol from the domain modules below so both apps see
 * one consistent contract for page/secret/sync/share shapes and tuning constants.
 */
export * from "./types";
export * from "./format-time";
export * from "./constants";
export * from "./generated-history";
export * from "./secret-parser";
export * from "./generator";
export * from "./wordlists";
export * from "./totp";
export * from "./credential-fields";
export * from "./attachments";
