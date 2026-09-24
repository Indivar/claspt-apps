// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The feature cards the vault gate shows beneath the specimen, one at a time,
 * and the scenes the specimen frame shows for them.
 *
 * Every card describes something this build does; the release brief is the
 * source and the wording is kept in step with it. Cards are shown in this
 * order from a different starting point each time the gate opens, so a
 * person who unlocks several times a day meets all of them without the
 * order feeling broken.
 *
 * A card names a scene and the lines of it to light up. Several cards can
 * share a scene: the frame then stays and only the highlight moves, and it
 * changes wholesale when the next card belongs to another scene. One fixed
 * picture beneath fifteen changing captions read as nothing happening.
 */

export type SceneId =
  "vault" | "agent" | "page" | "browser" | "devices" | "recovery" | "about";

export interface SceneLine {
  /** Named so a card can point at it. */
  key: string;
  /** Monospace text; a leading run of tree glyphs or spaces is drawn muted. */
  text: string;
  /** Drawn in the accent colour, for the one thing the line is about. */
  accent?: string;
  /** A rule above this line: a second part of the same scene. */
  divider?: boolean;
  /** The vault's sealed secret value, drawn by the frame with its seal animation. */
  secret?: boolean;
}

export interface Scene {
  id: SceneId;
  /** The frame's title bar, as a path or a place. */
  header: string;
  lines: readonly SceneLine[];
}

export interface GateCard {
  /** A short label for the area, shown above the title. */
  kicker: string;
  title: string;
  body: string;
  /** True for a Pro feature, said on the card. */
  pro?: boolean;
  scene: SceneId;
  /** Line keys of the scene to light up while this card shows. */
  highlight: readonly string[];
}

/**
 * The value before it is sealed. This is the example access key from AWS's
 * own documentation, which every secret scanner allowlists; a made-up one of
 * the same shape tripped gitleaks, this repository's CI gate included.
 */
export const SPECIMEN_PLAINTEXT = "AKIAIOSFODNN7EXAMPLE";
export const SPECIMEN_SEALED = "enc:v1:kR9xQ2+Lp7dTnW4aJ0sVhE8cM\u2026";

export const SCENES: Readonly<Record<SceneId, Scene>> = {
  vault: {
    id: "vault",
    header: "~/Documents/Claspt",
    lines: [
      { key: "tree-credentials", text: "\u251c\u2500 credentials/" },
      { key: "tree-page", text: "\u2502  \u2514\u2500 ", accent: "aws-production.md" },
      { key: "tree-general", text: "\u251c\u2500 general/" },
      { key: "tree-securenotes", text: "\u2514\u2500 .securenotes/" },
      { key: "tree-key", text: "   \u2514\u2500 vault.key" },
      { key: "page-title", text: "## AWS production", divider: true },
      { key: "page-account", text: "Account  4820-1157-9930" },
      { key: "secret-open", text: ":::secret[Secret access key]" },
      { key: "secret-value", text: "", secret: true },
      { key: "secret-close", text: ":::" },
    ],
  },
  agent: {
    id: "agent",
    header: "Access log \u00b7 today",
    lines: [
      {
        key: "log-read",
        text: "09:14  Claude Code  used    ",
        accent: "Secret access key",
      },
      { key: "log-ref", text: "       by reference \u00b7 the value never shown" },
      { key: "log-approve", text: "09:14  you approved it for this session" },
      {
        key: "log-memory",
        text: "09:16  Claude Code  wrote   ",
        accent: "ai/memory/decisions.md",
      },
      {
        key: "log-denied",
        text: "09:20  Cursor       denied  SSH key \u00b7 not approved",
      },
      { key: "log-run", text: "09:31  claspt run -- ./deploy.sh", divider: true },
      { key: "log-run-2", text: "       the secret handed to the command, never shown" },
      { key: "log-lock", text: "09:45  screen locked \u00b7 tools still answer" },
    ],
  },
  page: {
    id: "page",
    header: "general/bank-account.md",
    lines: [
      { key: "page-h", text: "## Bank account" },
      { key: "page-field", text: "Account  12-3456-7890123-00" },
      {
        key: "attach-1",
        text: "[statement-march.pdf]  ",
        accent: "encrypted \u00b7 Claspt only",
      },
      {
        key: "attach-2",
        text: "[card-front.jpg]       plain \u00b7 \u201cthe new card\u201d",
      },
      { key: "trash-h", text: "Trash", divider: true },
      { key: "trash-1", text: "old-bank.md    deleted 2 days ago \u00b7 28 days left" },
      { key: "trash-2", text: "notes-2024.md  deleted just now \u00b7 ", accent: "Undo" },
    ],
  },
  browser: {
    id: "browser",
    header: "shop.example \u00b7 checkout",
    lines: [
      { key: "bar", text: "Save alice@shop.example?   ", accent: "Save \u00b7 Not now" },
      { key: "fill", text: "Name, address, card   filled from \u201cPersonal\u201d" },
      { key: "passkey", text: "Passkey   signs in, no password to type" },
      { key: "totp", text: "Two-factor code   ", accent: "482 913" },
      {
        key: "gen",
        text: "Generated 09:02   24 chars \u00b7 used here \u00b7 in History",
        divider: true,
      },
    ],
  },
  devices: {
    id: "devices",
    header: "Sync \u00b7 two devices",
    lines: [
      { key: "dev-mac", text: "MacBook   version 391   pushed 09:14" },
      { key: "dev-phone", text: "iPhone    version 391   pulled 09:15 \u00b7 own key" },
      { key: "merge", text: "Roadmap.md edited on both \u00b7 newer wins, older kept" },
      {
        key: "share-h",
        text: "Share \u00b7 \u201cWi-Fi for guests\u201d",
        divider: true,
      },
      { key: "share-1", text: "Encrypted here, opened in their browser" },
      {
        key: "share-2",
        text: "Code \u00b7 expires in 7 days \u00b7 ",
        accent: "burns after one reading",
      },
    ],
  },
  recovery: {
    id: "recovery",
    header: "Recovery sheet \u00b7 printed 23 Sep 2026",
    lines: [
      { key: "r-vault", text: "Vault         Documents/Claspt" },
      { key: "r-key", text: "Recovery key  ", accent: "K7QD-\u2026-M2XA" },
      { key: "r-step-1", text: "1. Install Claspt on the new machine", divider: true },
      { key: "r-step-2", text: "2. Open the vault folder" },
      { key: "r-step-3", text: "3. Choose \u201cUse recovery key\u201d" },
      { key: "r-note", text: "A new master password does not change this key." },
    ],
  },
  about: {
    id: "about",
    header: "claspt.app",
    lines: [
      { key: "free", text: "Free    notes, secrets, extension, AI tools" },
      { key: "free-2", text: "        ", accent: "no trial clock, nothing expires" },
      { key: "pro", text: "Pro     sync, sharing, phone apps \u00b7 one tier" },
      { key: "src", text: "Source  github.com/Indivar/claspt-apps", divider: true },
      {
        key: "review",
        text: "        PolyForm Shield \u00b7 full security review first",
      },
    ],
  },
};

export const CARDS: readonly [GateCard, ...GateCard[]] = [
  {
    kicker: "Your vault",
    title: "It is just a folder",
    body: "Plain markdown files you can open in any editor, back up, move, or walk away with.",
    scene: "vault",
    highlight: ["tree-credentials", "tree-page", "tree-general"],
  },
  {
    kicker: "Encryption",
    title: "Only the secrets are encrypted",
    body: "Each secret block is sealed with AES-256-GCM. The key comes from your master password and never leaves this machine.",
    scene: "vault",
    highlight: ["secret-open", "secret-value", "secret-close"],
  },
  {
    kicker: "AI tools",
    title: "Safe to hand to an agent",
    body: "An AI agent can use a credential by reference and never see the value itself. You decide what it may read, and every read is logged.",
    scene: "agent",
    highlight: ["log-read", "log-ref", "log-approve", "log-denied"],
  },
  {
    kicker: "Agent memory",
    title: "Your AI remembers between sessions",
    body: "Claude, ChatGPT, Cursor or any MCP client keeps its notes in your vault, in plain markdown you can read and edit.",
    scene: "agent",
    highlight: ["log-memory"],
  },
  {
    kicker: "Attachments",
    title: "Put the scan next to the number",
    body: "Pick, drag or paste images and PDFs into a page. Each time, one question: encrypt this file? Sealed files open only inside Claspt.",
    scene: "page",
    highlight: ["attach-1", "attach-2"],
  },
  {
    kicker: "Trash",
    title: "Deleted is not gone",
    body: "A deleted page waits in the trash. Undo at once, or restore it later from Settings. Its secrets stay encrypted while it waits.",
    scene: "page",
    highlight: ["trash-h", "trash-1", "trash-2"],
  },
  {
    kicker: "Sharing",
    title: "Sharing we cannot read",
    body: "A share is encrypted on your machine and opened in the other person's browser. Add a code, an expiry, or burn after one reading.",
    pro: true,
    scene: "devices",
    highlight: ["share-h", "share-1", "share-2"],
  },
  {
    kicker: "Browser extension",
    title: "It fills who you are",
    body: "Save an identity once and checkout forms fill themselves. Passkeys and two-factor codes sit beside the passwords they protect.",
    scene: "browser",
    highlight: ["fill", "passkey", "totp"],
  },
  {
    kicker: "Sync",
    title: "A second device in two steps",
    body: "Each device proves itself with its own key. If two devices edit the same page while apart, the newer edit wins and Claspt tells you.",
    pro: true,
    scene: "devices",
    highlight: ["dev-mac", "dev-phone", "merge"],
  },
  {
    kicker: "Generator",
    title: "Every generated password is kept",
    body: "Password, passphrase, memorable, PIN or UUID, with a history of the ones you used, on the desktop and in the extension.",
    scene: "browser",
    highlight: ["gen"],
  },
  {
    kicker: "Recovery",
    title: "A recovery key you can print",
    body: "The sheet carries the vault's name, the date and the steps. Changing your master password does not change the key.",
    scene: "recovery",
    highlight: ["r-key", "r-note"],
  },
  {
    kicker: "Locking",
    title: "Lock the screen, keep the tools working",
    body: "Screen lock hides the vault. Key lock clears the key. A tool at work counts as activity, so an agent mid-task is not cut off.",
    scene: "agent",
    highlight: ["log-lock"],
  },
  {
    kicker: "Automation",
    title: "Programs use a secret the agent never sees",
    body: "claspt run hands a credential to a command. SSH keys stay in the vault, and rotation reminders say when a secret is due.",
    scene: "agent",
    highlight: ["log-run", "log-run-2"],
  },
  {
    kicker: "Pricing",
    title: "Free stays free",
    body: "No trial clock. Pro is one tier: sync, sharing and the mobile apps.",
    scene: "about",
    highlight: ["free", "free-2", "pro"],
  },
  {
    kicker: "The code",
    title: "Read the source",
    body: "Source-available under the PolyForm Shield licence, published after a full security review.",
    scene: "about",
    highlight: ["src", "review"],
  },
];

/** The card at `index`; the list is never empty, so there is always one. */
export function cardAt(index: number): GateCard {
  return CARDS[index] ?? CARDS[0];
}

/** How long a card stays before the next one. */
export const CARD_INTERVAL_MS = 10_000;

/** Where to start, from a seed such as the time the gate opened. */
export function startIndex(seed: number, count: number): number {
  if (count <= 0) return 0;
  return Math.abs(Math.floor(seed)) % count;
}

export function nextIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return (index + 1) % count;
}

export function prevIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return (index - 1 + count) % count;
}
