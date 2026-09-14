// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Page-level model and secret handling: the frontmatter [`model`] (parse and
//! serialize `.md` pages) and the [`secret`] block engine that encrypts on save
//! and decrypts on read. Key invariant: only secret block *values* are ever
//! encrypted — labels, titles, tags, and all other markdown stay plaintext so a
//! page remains a portable, grep-able `.md` file even without Claspt.
pub mod error;
pub mod model;
pub mod secret;
