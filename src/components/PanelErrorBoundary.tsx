// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * React error boundary scoped to an individual panel. Catches render errors in
 * its subtree, logs them (tagged with the optional `name`), and shows a compact
 * inline fallback with a "Try again" reset — so one broken panel doesn't crash
 * the whole app.
 */
import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Error boundary that isolates render failures to a single panel. */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[${this.props.name ?? "Panel"}] Error:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-red-500 dark:text-red-400">
            <div className="text-center">
              <p className="font-medium">
                {this.props.name ?? "Panel"} encountered an error
              </p>
              {this.state.error && (
                <p className="mt-1 max-w-[220px] text-[10px] leading-relaxed text-red-400/70">
                  {this.state.error.message}
                </p>
              )}
              <button
                className="mt-2 text-xs underline hover:no-underline"
                onClick={() => this.setState({ hasError: false, error: null })}
              >
                Try again
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
