/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { probeComponents } from "./components";

import type { FetchLike } from "../instance/pod-proxy";

type Answer = { status: number; body?: unknown };

/** A fake API server: answers by the path of the request, and records every path asked. */
function server(answers: (path: string) => Answer) {
  const asked: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const path = decodeURIComponent(String(url));
    asked.push(path);
    const { status, body } = answers(path);
    return { status, text: async () => JSON.stringify(body ?? {}) } as Response;
  };
  return { asked, fetchImpl };
}

const list = (...items: unknown[]): Answer => ({ status: 200, body: { items } });
const deployment = (namespace: string, image: string, labels: Record<string, string> = {}) => ({
  metadata: { namespace, labels },
  spec: { template: { spec: { containers: [{ image }] } } },
});

describe("probeComponents (SPEC-0036)", () => {
  it("reads the lab: the CRDs by a filtered list, the versions from the images", async () => {
    const { asked, fetchImpl } = server((path) => {
      if (path.includes("customresourcedefinitions?fieldSelector=metadata.name=")) {
        return path.includes("klio") ? list() : list({ metadata: {} });
      }
      if (path.includes("labelSelector=app.kubernetes.io/name=cloudnative-pg")) {
        return list(deployment("cnpg-system", "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1"));
      }
      if (path.includes("labelSelector=app.kubernetes.io/name=cert-manager")) {
        return list(
          deployment("cert-manager", "quay.io/jetstack/cert-manager-webhook:v1.21.2", {
            "app.kubernetes.io/component": "webhook",
          }),
          deployment("cert-manager", "quay.io/jetstack/cert-manager-controller:v1.21.2", {
            "app.kubernetes.io/component": "controller",
          }),
        );
      }
      if (path.includes("/api/v1/services?labelSelector=cnpg.io/pluginName=barman-cloud.cloudnative-pg.io")) {
        return list({ metadata: { namespace: "cnpg-system" }, spec: { selector: { app: "barman-cloud" } } });
      }
      if (path.includes("/namespaces/cnpg-system/deployments?labelSelector=app=barman-cloud")) {
        return list(deployment("cnpg-system", "ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.15.1"));
      }
      return list();
    });

    expect(await probeComponents(fetchImpl)).toEqual({
      operator: { crd: "present", version: "1.30.1", namespace: "cnpg-system" },
      certManager: { crd: "present", version: "v1.21.2", namespace: "cert-manager" },
      barmanCloud: { crd: "present", version: "v0.15.1", namespace: "cnpg-system" },
      klio: { crd: "absent" },
    });
    // Never a get of one CRD: a missing one would be a 404 in the console of the renderer.
    expect(asked.some((path) => /customresourcedefinitions\/[a-z]/.test(path))).toBe(false);
  });

  it("knows nothing, rather than nothing installed, when the API server refuses", async () => {
    const { fetchImpl } = server(() => ({ status: 403 }));
    const components = await probeComponents(fetchImpl);
    expect(components.operator).toEqual({ crd: "unknown" });
    expect(components.klio).toEqual({ crd: "unknown" });
  });
});
