/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { collectionPath, dryRunCreate } from "./dry-run";

import type { PostLike } from "./dry-run";

describe("the dry run of a create (SPEC-0032)", () => {
  it("puts the namespace before the plural, and leaves a cluster scoped kind alone", () => {
    expect(collectionPath({ apiBase: "/apis/postgresql.cnpg.io/v1/clusters", namespace: "cnpg-e2e" })).toBe(
      "/apis/postgresql.cnpg.io/v1/namespaces/cnpg-e2e/clusters",
    );
    expect(collectionPath({ apiBase: "/apis/postgresql.cnpg.io/v1/clusterimagecatalogs" })).toBe(
      "/apis/postgresql.cnpg.io/v1/clusterimagecatalogs",
    );
  });

  it("POSTs the body as JSON with dryRun=All through the cluster proxy and reads the answer", async () => {
    const calls: Array<[string, Parameters<PostLike>[1]]> = [];
    const post: PostLike = async (url, init) => {
      calls.push([url, init]);
      return { status: 422, text: async () => JSON.stringify({ code: 422, message: "no" }) };
    };
    const answer = await dryRunCreate(
      { apiBase: "/apis/g/v1/poolers", namespace: "ns", body: { kind: "Pooler" } },
      post,
    );
    expect(answer).toEqual({ status: 422, body: { code: 422, message: "no" } });
    expect(calls[0][0]).toBe("/api-kube/apis/g/v1/namespaces/ns/poolers?dryRun=All");
    expect(calls[0][1].method).toBe("POST");
    expect(calls[0][1].body).toBe('{"kind":"Pooler"}');
    expect(calls[0][1].headers["Content-Type"]).toBe("application/json");
  });

  it("keeps a body that is not JSON as a message, and a failure as status 0", async () => {
    const text: PostLike = async () => ({ status: 502, text: async () => "Bad gateway" });
    expect(await dryRunCreate({ apiBase: "/a/b", body: {} }, text)).toEqual({
      status: 502,
      body: { message: "Bad gateway" },
    });
    const failing: PostLike = async () => {
      throw new Error("offline");
    };
    expect(await dryRunCreate({ apiBase: "/a/b", body: {} }, failing)).toEqual({ status: 0 });
  });
});
