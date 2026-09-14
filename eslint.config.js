// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import nounsanitized from "eslint-plugin-no-unsanitized";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "no-unsanitized": nounsanitized,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Security: flag raw innerHTML/insertAdjacentHTML sinks so any new one is
      // a conscious, reviewed decision. The few existing sinks feed
      // DOMPurify-sanitized or library-trusted HTML and carry a justified
      // inline disable.
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
  prettier,
);
