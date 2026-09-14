// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ErrorBoundary — top-level React error boundary.
 *
 * Catches render/runtime errors from the component tree and shows a recovery
 * screen (reload or attempt-to-continue) with expandable error details and
 * the app version, instead of a blank white screen. Reassures the user that
 * vault files on disk are unaffected. Also logs details to the console.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { VERSION_DISPLAY } from "@/lib/version";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}

/** Class-based error boundary wrapping the app tree. */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: "" };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const errorDetails = [
      `[${new Date().toISOString()}] Claspt v${VERSION_DISPLAY}`,
      `Error: ${error.message}`,
      `Stack: ${error.stack ?? "N/A"}`,
      `Component: ${info.componentStack ?? "N/A"}`,
    ].join("\n");

    this.setState({ errorInfo: errorDetails });

    // Log to console for dev tools
    console.error("Claspt Error Boundary caught:", errorDetails);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null, errorInfo: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-surface p-8">
          <div className="w-full max-w-lg rounded-xl border border-danger/30 bg-surface-raised p-6">
            <h2 className="text-lg font-semibold text-danger">Something went wrong</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Claspt encountered an unexpected error. Your data is safe — vault files are
              not affected.
            </p>

            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-text-muted hover:text-text-secondary">
                Error details
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface p-3 text-xs text-text-muted">
                {this.state.error?.message}
                {"\n\n"}
                {this.state.error?.stack}
              </pre>
            </details>

            <div className="mt-6 flex gap-3">
              <button
                onClick={this.handleReload}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Reload App
              </button>
              <button
                onClick={this.handleDismiss}
                className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-overlay"
              >
                Try to Continue
              </button>
            </div>

            <p className="mt-4 text-xs text-text-muted">
              v{VERSION_DISPLAY} — If this keeps happening, please report it.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
