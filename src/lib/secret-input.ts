// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The attributes every field holding a password, passphrase, recovery key or
 * secret value must carry.
 *
 * macOS text substitution rewrites what is typed. Entering `test123` into a
 * revealed password field produced `Test123` — capitalised by the system,
 * offered as a correction, and accepted without the person noticing. The
 * confirm field then disagreed with a password the user believed they had
 * typed twice, and had they been typing into the first field instead, they
 * would have created a vault whose password was not the one they had in mind.
 *
 * The effect is worst exactly where it matters most: a `type="password"` field
 * is left alone by WebKit, but the "Show" toggle turns it into `type="text"`,
 * and that is when the substitution fires.
 *
 * Four attributes rather than one because the behaviours are separate —
 * capitalisation, autocorrection, spelling, and autofill — and a field that
 * silently alters a credential is a data-loss bug, not a cosmetic one.
 *
 * Spread onto the element: `<input {...SECRET_INPUT_PROPS} type="password" />`.
 * `src/__tests__/secret-input.test.ts` fails if a credential field is added
 * without it.
 */
export const SECRET_INPUT_PROPS = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;
