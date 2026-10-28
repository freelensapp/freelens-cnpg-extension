import { defineConfig } from "vitest/config";

// The integration tests attach to Freelens dev over CDP and drive one app
// against the kind cluster of `pnpm e2e:cluster:up`, so they are not part of
// vitest.config.ts and run only via `pnpm test:integration`.
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["integration/__tests__/**/*.tests.ts"],
    // One app, one session at a time: the sessions install the extension and
    // write to one cluster.
    fileParallelism: false,
    // A write case waits for the operator: a switchover, a restart in order,
    // a cluster brought up from its form (SPEC-0020 to SPEC-0029).
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
