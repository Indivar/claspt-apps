// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * logger.ts — lightweight namespaced console logger for the frontend.
 *
 * Provides {@link createLogger} to build per-module loggers (`createLogger("vault")`)
 * that prefix each line with an ISO timestamp, level, and module name, and color
 * it by severity. A global minimum level gates output — it defaults to `debug` in
 * dev and `warn` in production builds — so verbose `debug`/`info` calls are free
 * to leave in place. {@link log} is the shared root ("app") logger.
 */
import { VERSION_DISPLAY } from "./version";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "color: #71717a",
  info: "color: #60a5fa",
  warn: "color: #fbbf24",
  error: "color: #ef4444",
};

let minLevel: LogLevel = import.meta.env.DEV ? "debug" : "warn";

/** Set the minimum log level. Messages below this level are suppressed. */
export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

/** Get the current minimum log level. */
export function getLogLevel(): LogLevel {
  return minLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(level: LogLevel, module: string, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] [${module}] ${message}`;
}

/** Create a namespaced logger for a module. */
export function createLogger(module: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (!shouldLog("debug")) return;
      console.debug(
        `%c${formatMessage("debug", module, msg)}`,
        LEVEL_COLORS.debug,
        ...args,
      );
    },

    info(msg: string, ...args: unknown[]) {
      if (!shouldLog("info")) return;
      console.info(`%c${formatMessage("info", module, msg)}`, LEVEL_COLORS.info, ...args);
    },

    warn(msg: string, ...args: unknown[]) {
      if (!shouldLog("warn")) return;
      console.warn(`%c${formatMessage("warn", module, msg)}`, LEVEL_COLORS.warn, ...args);
    },

    error(msg: string, ...args: unknown[]) {
      if (!shouldLog("error")) return;
      console.error(
        `%c${formatMessage("error", module, msg)}`,
        LEVEL_COLORS.error,
        ...args,
      );
    },
  };
}

/** Root application logger. */
export const log = createLogger("app");

// Log app startup
log.info(`Claspt v${VERSION_DISPLAY} frontend initialized`);
