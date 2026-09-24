// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The framed specimen on the vault gate: one scene of the product, drawn as
 * monospace lines, with the lines the current card is about lit and the
 * rest held back. The frame is a picture of what the product does, framed
 * so it reads as an example rather than as part of the page.
 */
import {
  SPECIMEN_PLAINTEXT,
  SPECIMEN_SEALED,
  type Scene,
  type SceneLine,
} from "@/lib/gate-cards";

interface Props {
  scene: Scene;
  /** Keys of the lines to light up; the rest are held back. */
  highlight: readonly string[];
  /** Whether the vault scene's secret has sealed itself yet. */
  sealed: boolean;
}

/** Tree glyphs and leading spaces are drawn muted; the words are not. */
function splitPrefix(text: string): [string, string] {
  const match = /^[\s\u2500-\u257f]+/.exec(text);
  if (!match) return ["", text];
  return [match[0], text.slice(match[0].length)];
}

function LineText({ line, sealed }: { line: SceneLine; sealed: boolean }) {
  if (line.secret) {
    return (
      <span className={sealed ? "specimen-sealed" : "specimen-plain"}>
        {sealed ? (
          <span className="text-accent">{SPECIMEN_SEALED}</span>
        ) : (
          <span className="text-text-primary">{SPECIMEN_PLAINTEXT}</span>
        )}
      </span>
    );
  }
  const [prefix, rest] = splitPrefix(line.text);
  return (
    <>
      {prefix && <span className="whitespace-pre text-text-muted">{prefix}</span>}
      <span className="whitespace-pre-wrap">{rest}</span>
      {line.accent && <span className="text-accent">{line.accent}</span>}
    </>
  );
}

export function GateSpecimen({ scene, highlight, sealed }: Props) {
  const lit = new Set(highlight);
  const anyLit = lit.size > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-surface-raised/70 shadow-sm">
      <div className="border-b border-border/70 px-3.5 py-2">
        <p className="truncate font-mono text-[11px] text-text-muted">{scene.header}</p>
      </div>
      {/* A fixed height for the tallest scene, so the card beneath never jumps. */}
      <div
        className="min-h-[248px] px-3.5 py-3 font-mono text-[12px] leading-[1.8] text-text-secondary"
        aria-label={`An example: ${scene.header}`}
      >
        {scene.lines.map((line) => {
          const state = !anyLit ? "" : lit.has(line.key) ? "specimen-hi" : "specimen-dim";
          return (
            <p
              key={line.key}
              data-line={line.key}
              className={`specimen-line ${state}${line.divider ? " mt-3 border-t border-border/50 pt-3" : ""}`}
            >
              <LineText line={line} sealed={sealed} />
            </p>
          );
        })}
      </div>
    </div>
  );
}
