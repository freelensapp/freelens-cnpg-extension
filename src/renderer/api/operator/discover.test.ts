/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { discoverOperatorNamespaces } from "./discover";

const items = (...namespaces: string[]) =>
  JSON.stringify({
    items: namespaces.map((namespace) => ({ metadata: { namespace, name: "cnpg-controller-manager" } })),
  });

describe("discoverOperatorNamespaces", () => {
  it("asks once, cluster-wide, by the operator's label", async () => {
    const urls: string[] = [];
    const result = await discoverOperatorNamespaces(async (url, init) => {
      urls.push(`${init.method} ${url}`);
      return { status: 200, text: async () => items("cnpg-system", "team-a", "cnpg-system") };
    });
    expect(result).toEqual({ namespaces: ["cnpg-system", "team-a"], narrowed: false });
    expect(urls).toEqual([
      "GET /api-kube/apis/apps/v1/deployments?labelSelector=app.kubernetes.io%2Fname%3Dcloudnative-pg",
    ]);
  });

  it("falls back to the usual namespaces when the cluster-wide list is refused", async () => {
    const urls: string[] = [];
    const result = await discoverOperatorNamespaces(async (url) => {
      urls.push(url);
      if (!url.includes("/namespaces/")) return { status: 403, text: async () => "forbidden" };
      return url.includes("/namespaces/cnpg-system/")
        ? { status: 200, text: async () => items("cnpg-system") }
        : { status: 403, text: async () => "forbidden" };
    });
    expect(result).toEqual({ namespaces: ["cnpg-system"], narrowed: true });
    expect(urls).toHaveLength(4);
  });

  it("finds nothing without failing when nothing answers", async () => {
    const result = await discoverOperatorNamespaces(async () => {
      throw new Error("network down");
    });
    expect(result).toEqual({ namespaces: [], narrowed: true });
  });
});
