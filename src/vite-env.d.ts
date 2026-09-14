// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/// <reference types="vite/client" />

// Ambient type declarations for the Vite build.
// The `vite/client` reference above pulls in types for import.meta.env, asset
// imports, and the compile-time defines injected in vite.config.ts
// (__APP_VERSION__, __GIT_HASH__, etc.).
//
// KaTeX's mhchem contrib plugin ships without bundled type definitions; these
// module stubs let the chemistry markdown extension import it without a TS error.
declare module "katex/contrib/mhchem";
declare module "katex/contrib/mhchem/mhchem.js";
