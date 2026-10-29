/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { PluginConfiguration } from "../api/klio/plugin-configuration-v1alpha1";
import { klioFacts } from "./klio";

/** The sample of the Klio repository (operator/config/samples), in a namespace, with a Ready condition. */
function configuration(conditions?: { type: string; status: string; reason?: string; message?: string }[]) {
  return new PluginConfiguration({
    apiVersion: "klio.cnpg.io/v1alpha1",
    kind: "PluginConfiguration",
    metadata: { name: "pluginconfiguration-sample", namespace: "default" },
    spec: {
      serverAddress: "server-sample.default",
      clusterName: "cluster-example",
      clientSecretName: "cluster-example-klio-user",
      serverSecretName: "server-sample-tls",
      tier1: { retention: { latest: 10 } },
      tier2: { enableBackup: true, enableRecovery: true, retention: { latest: 10 } },
      walPrefetch: { count: 2, maxConcurrentDownloads: 4 },
    },
    status: conditions ? { conditions } : undefined,
  } as never);
}

const user = (name: string, ref: string, enabled?: boolean) => ({
  metadata: { name, namespace: "default" },
  spec: { plugins: [{ name: "klio.cnpg.io", enabled, parameters: { pluginConfigurationRef: ref } }] },
});

describe("Klio configurations (SPEC-0036)", () => {
  it("reads the cluster, the server, the tiers and the readiness", () => {
    const facts = klioFacts(configuration([{ type: "Ready", status: "True", reason: "Ready" }]), [
      user("cluster-example", "pluginconfiguration-sample"),
    ]);
    expect(facts).toEqual({
      cluster: "cluster-example",
      usedBy: ["cluster-example"],
      unused: false,
      mode: "standard",
      server: "server-sample.default",
      tiers: [
        { tier: "Tier 1", words: "keeps the latest 10" },
        { tier: "Tier 2", words: "backups copied, recovery from it, keeps the latest 10" },
      ],
      state: "Ready",
      className: "success",
      reason: "Ready",
    });
  });

  it("says nothing uses a configuration no enabled Klio entry names, and reports a missing condition", () => {
    const facts = klioFacts(configuration(), [
      user("cluster-example", "another"),
      user("disabled", "pluginconfiguration-sample", false),
      { ...user("elsewhere", "pluginconfiguration-sample"), metadata: { name: "elsewhere", namespace: "other" } },
    ]);
    expect(facts).toMatchObject({
      usedBy: [],
      unused: true,
      state: "Unknown",
      className: "info",
      reason: "The controller reports no Ready condition",
    });
  });

  it("carries the controller's message when it is not ready", () => {
    const facts = klioFacts(
      configuration([
        { type: "Ready", status: "False", reason: "SecretMissing", message: "secret server-sample-tls not found" },
      ]),
      [],
    );
    expect(facts).toMatchObject({
      state: "Not ready",
      className: "error",
      reason: "secret server-sample-tls not found",
    });
  });
});
