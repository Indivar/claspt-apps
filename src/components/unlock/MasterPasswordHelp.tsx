// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * How strong the master password is, and help generating a better one.
 *
 * The create form used to say only "Min 12 characters". A twelve-character
 * password can be trivial, and nothing offered any help — while every secret
 * in the vault is sealed with a key derived from that one string. What is at
 * stake is stated by [`MasterPasswordWarning`], above the field rather than
 * below it, where it is read before the password is chosen.
 *
 * This informs and does not block. The minimum is unchanged and a weak
 * password is still accepted, because that is the owner's decision about their
 * own data.
 *
 * Nothing here is fixed. Passphrase or password, longer or shorter, generated
 * as many times as it takes to get one they like — the recommendation is
 * stated once and then it is their choice. This is the one password that
 * cannot live in a password manager, because it is the key to the password
 * manager, so the person has to remember it; which of the two they will
 * actually remember is something only they know.
 */
import { useEffect, useState } from "react";
import * as cmd from "@/lib/commands";
import type { StrengthResult } from "@/lib/commands";

/** Bar colour per score band, from the generator's own 0–4 scale. */
const BAR = ["bg-danger", "bg-danger", "bg-warning", "bg-success/70", "bg-success"];

type Kind = "passphrase" | "password";

/** Room to go weaker or stronger, with a sensible middle. */
// Six words is 77.5 bits against a public list, which is the right assumption:
// the list is not the secret, the selection is. Five was already strong, and
// six is four more characters to remember for a margin that outlasts hardware.
const WORDS = { min: 4, max: 10, default: 6 };
const CHARS = { min: 12, max: 48, default: 20 };

export function MasterPasswordHelp({
  password,
  onSuggest,
}: {
  password: string;
  /** Fills both password fields and reveals them so they can be written down. */
  onSuggest: (value: string) => void;
}) {
  const [lastStrength, setLastStrength] = useState<StrengthResult | null>(null);
  // An emptied field shows no reading; the last one is kept for when typing resumes.
  const strength = password ? lastStrength : null;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("passphrase");
  const [words, setWords] = useState(WORDS.default);
  const [chars, setChars] = useState(CHARS.default);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!password) return;
    let cancelled = false;
    // Debounced: this crosses IPC on every keystroke otherwise.
    const timer = window.setTimeout(() => {
      cmd
        .checkPasswordStrength(password)
        .then((s) => {
          if (!cancelled) setLastStrength(s);
        })
        .catch(() => {
          // A strength reading is advice, not a gate. If it cannot be
          // computed the form still works exactly as before.
          if (!cancelled) setLastStrength(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [password]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === "passphrase"
          ? await cmd.generatePassphrase({
              word_count: words,
              separator: "-",
              capitalize: false,
              include_number: false,
              word_list: "eff",
            })
          : await cmd.generatePassword({
              length: chars,
              uppercase: true,
              lowercase: true,
              numbers: true,
              special: true,
              exclude_ambiguous: true,
            });
      onSuggest(result.value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const score = strength ? Math.min(4, Math.max(0, strength.score)) : 0;

  return (
    <div className="mt-2">
      {strength && (
        <div className="mb-2">
          <div className="flex gap-1" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={`h-[3px] flex-1 rounded-full ${
                  i <= score ? BAR[score] : "bg-border/60"
                }`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-muted">
            <span className="font-medium text-text-secondary">{strength.label}</span> —{" "}
            {/* The backend returns "instant" as well as spans like "3 hours",
                and "about instant to guess" is not a sentence. */}
            {strength.crack_time_display === "instant"
              ? "guessed instantly."
              : `about ${strength.crack_time_display} to guess.`}
          </p>
        </div>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2.5 rounded-xl border border-accent/40 bg-accent/[0.07] px-4 py-2.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/[0.12]"
        >
          Help me choose a strong one
        </button>
      ) : (
        <div className="mt-2.5 rounded-xl border border-border/60 bg-surface-raised/50 px-3.5 py-3">
          <div className="mb-2.5 flex gap-1 rounded-lg border border-border/60 bg-surface p-[3px]">
            {(
              [
                ["passphrase", "Passphrase"],
                ["password", "Password"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`flex-1 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors ${
                  kind === value
                    ? "bg-surface-overlay text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mb-2.5 flex items-center gap-3">
            <Stepper
              label={kind === "passphrase" ? "Words" : "Characters"}
              value={kind === "passphrase" ? words : chars}
              min={kind === "passphrase" ? WORDS.min : CHARS.min}
              max={kind === "passphrase" ? WORDS.max : CHARS.max}
              onChange={kind === "passphrase" ? setWords : setChars}
            />
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              className="ml-auto rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60 disabled:opacity-50"
            >
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>

          <p className="text-[11.5px] leading-relaxed text-text-muted">
            A passphrase is usually the easier one to remember, and length buys more
            safety than symbols do. A password is fine too, if it is the one you will
            actually remember. Generate as many as you like until one sticks.
          </p>

          {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Small − / + control. A slider is imprecise at this size and a text field
 *  invites values the generator would reject. */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-surface px-1 py-0.5">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={value <= min}
          aria-label={`Fewer ${label.toLowerCase()}`}
          className="rounded px-1.5 text-[13px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-30"
        >
          −
        </button>
        <span className="min-w-[1.5rem] text-center font-mono text-[12px] text-text-primary">
          {value}
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={value >= max}
          aria-label={`More ${label.toLowerCase()}`}
          className="rounded px-1.5 text-[13px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * What this password is worth, said before it is typed.
 *
 * The wording matters and an earlier draft of it was wrong. It claimed the
 * password "cannot be reset", which contradicts the recovery screen the app
 * already has: paste the recovery key, set a new password, done. The recovery
 * key IS the master key, base64-encoded, so recovering re-wraps the same key
 * under whatever new password is given.
 *
 * What is actually true: the recovery key is the only way back in without the
 * password, nobody at Claspt can reset anything, and losing both leaves a
 * vault no one can open.
 */
export function MasterPasswordWarning() {
  return (
    <div className="mb-3 rounded-xl border border-warning/35 bg-warning/[0.07] px-4 py-3">
      <p className="mb-1 text-[13px] font-semibold text-text-primary">
        This password is the only key to your vault
      </p>
      <p className="max-w-[52ch] text-[12.5px] leading-relaxed text-text-secondary">
        Everything you store is encrypted with a key made from it. If you forget it, the
        recovery key you are shown next is the only way back in — nobody at Claspt can
        reset it for you. Lose both and nothing in the vault can ever be opened again.
      </p>
    </div>
  );
}
