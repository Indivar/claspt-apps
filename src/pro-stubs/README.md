# Stand-ins for the commercial modules

The public, source-available tree does not contain sync, sharing or the licence
system. The files here have the same exported surface as those modules and do
nothing: stores whose actions resolve at once, components that render nothing.

They are only ever used when the real file is absent. `scripts/vite-pro-fallback.mjs`
(for Vite and Vitest) and the `paths` fallbacks in `tsconfig.json` (for tsc)
resolve `@/stores/sync-store` and the rest to the real file when it exists and
to the stub when it does not, so nothing that imports them changes between the
two trees. In the private tree, `src/__tests__/pro-stubs-contract.test.ts`
type-checks each stub against the real module so the two cannot drift.
