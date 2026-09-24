// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * What someone can say they will use a vault for, and which setup step each
 * choice pulls in.
 *
 * Kept apart from the components so the list is one obvious place to edit: a new
 * use case is an entry here plus, if it needs configuring, one step component.
 */

export type UseCaseId = "passwords" | "notes" | "secrets" | "assistant" | "devices";

export interface UseCase {
  id: UseCaseId;
  title: string;
  /** One sentence anyone can follow, with no jargon. */
  plain: string;
  /**
   * The mechanism, for a reader who wants to know. Deliberately more technical:
   * someone non-technical stops after `plain` and still chooses correctly, and
   * a developer can see what the product actually is.
   */
  detail: string;
  /** Ticked when the walkthrough opens. */
  defaultOn: boolean;
  /**
   * Needs a Pro licence, so the walkthrough cannot set it up. Shown, because
   * someone choosing a vault should know the capability exists, but not
   * selectable: ticking a box that silently does nothing is worse than not
   * offering it.
   */
  pro?: boolean;
}

export const USE_CASES: UseCase[] = [
  {
    id: "passwords",
    title: "Passwords and logins",
    plain: "Store your logins, and have Claspt fill them in for you on websites.",
    detail:
      "Browser extension, password generator, one-time codes, and import from another password manager.",
    defaultOn: true,
  },
  {
    id: "notes",
    title: "Notes and documents",
    plain:
      "Write and search notes. They stay as ordinary text files you can open in any other program.",
    detail:
      "Markdown files, folders, tags, full-text search, and a history of every change.",
    defaultOn: true,
  },
  {
    id: "secrets",
    title: "API keys and project secrets",
    plain:
      "Store keys and configuration values, and read them from your terminal or your own scripts.",
    detail:
      "A local API on this computer only, command-line access, and a folder per project.",
    defaultOn: false,
  },
  {
    id: "assistant",
    title: "AI tools (Claude, ChatGPT, Cursor)",
    plain:
      "Give an AI tool permission to read your notes and write new ones, so it remembers what you tell it.",
    detail:
      "Connects over MCP. Anything the tool reads is sent to that AI service as part of your conversation, so you choose what it may see. Passwords stay hidden unless you allow them.",
    defaultOn: false,
  },
  {
    id: "devices",
    title: "My phone and other computers",
    plain: "Keep your vault up to date on every device you use.",
    detail:
      "Encrypted before it leaves this computer, and the server never holds the key. Includes the iOS and Android apps.",
    defaultOn: false,
    pro: true,
  },
];

/**
 * Which optional step each use case contributes, if any.
 *
 * `notes` contributes nothing because there is nothing to configure, and
 * `secrets` and `devices` are served by screens that already exist in Settings.
 * A use case with no step still changes what the final summary says.
 */
export const STEP_FOR: Partial<Record<UseCaseId, "passwords" | "assistant">> = {
  passwords: "passwords",
  assistant: "assistant",
};
