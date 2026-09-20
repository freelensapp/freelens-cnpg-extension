/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it, vi } from "vitest";
import { ACCESS_REVIEW_PATH, AccessReviews, accessGuard, accessKey, resourceWords, reviewBody } from "./access-review";

import type { AccessQuestion, ReviewFetch } from "./access-review";

const PATCH_STATUS: AccessQuestion = {
  verb: "patch",
  group: "postgresql.cnpg.io",
  resource: "clusters",
  subresource: "status",
  namespace: "db",
};
const DELETE_PODS: AccessQuestion = { verb: "delete", group: "", resource: "pods", namespace: "db" };

function answering(allowed: unknown, status = 201) {
  return vi.fn<ReviewFetch>(async () => ({ status, json: async () => ({ status: { allowed } }) }));
}

describe("the request", () => {
  it("asks about the subresource when there is one", () => {
    expect(reviewBody(PATCH_STATUS)).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: {
        resourceAttributes: {
          namespace: "db",
          verb: "patch",
          group: "postgresql.cnpg.io",
          resource: "clusters",
          subresource: "status",
        },
      },
    });
    expect(reviewBody(DELETE_PODS)).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { namespace: "db", verb: "delete", group: "", resource: "pods" } },
    });
  });

  it("posts to the authorization API behind the host's cluster proxy", async () => {
    const fetchLike = answering(true);
    await new AccessReviews(fetchLike).ask(PATCH_STATUS);
    const [url, init] = fetchLike.mock.calls[0];
    expect(url).toBe(ACCESS_REVIEW_PATH);
    expect(url).toBe("/api-kube/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(reviewBody(PATCH_STATUS));
  });

  it("spells resources as RBAC does", () => {
    expect(resourceWords(PATCH_STATUS)).toBe("clusters/status");
    expect(resourceWords(DELETE_PODS)).toBe("pods");
    expect(accessKey(PATCH_STATUS)).not.toBe(accessKey({ ...PATCH_STATUS, subresource: undefined }));
  });
});

describe("the answers", () => {
  it("reads allowed and denied", async () => {
    expect(await new AccessReviews(answering(true)).ask(PATCH_STATUS)).toBe("allowed");
    expect(await new AccessReviews(answering(false)).ask(PATCH_STATUS)).toBe("denied");
  });

  it("is unknown when the review is refused, fails or says nothing", async () => {
    expect(await new AccessReviews(answering(true, 403)).ask(PATCH_STATUS)).toBe("unknown");
    expect(await new AccessReviews(answering(undefined)).ask(PATCH_STATUS)).toBe("unknown");
    const failing = vi.fn<ReviewFetch>(async () => {
      throw new Error("Failed to fetch");
    });
    expect(await new AccessReviews(failing).ask(PATCH_STATUS)).toBe("unknown");
    const garbage = vi.fn<ReviewFetch>(async () => ({ status: 201, json: async () => "nope" }));
    expect(await new AccessReviews(garbage).ask(PATCH_STATUS)).toBe("unknown");
  });

  it("is unknown until asked", () => {
    expect(new AccessReviews(answering(false)).peek(PATCH_STATUS)).toBe("unknown");
  });
});

describe("the cache", () => {
  it("asks once per question while the answer is fresh, and again after a minute", async () => {
    let now = 1_000_000;
    const fetchLike = answering(false);
    const reviews = new AccessReviews(fetchLike, () => now);

    await reviews.ask(PATCH_STATUS);
    await reviews.ask(PATCH_STATUS);
    expect(fetchLike).toHaveBeenCalledTimes(1);
    expect(reviews.peek(PATCH_STATUS)).toBe("denied");

    await reviews.ask(DELETE_PODS);
    expect(fetchLike).toHaveBeenCalledTimes(2);

    now += 59_999;
    await reviews.ask(PATCH_STATUS);
    expect(fetchLike).toHaveBeenCalledTimes(2);

    now += 1;
    expect(reviews.peek(PATCH_STATUS)).toBe("unknown");
    await reviews.ask(PATCH_STATUS);
    expect(fetchLike).toHaveBeenCalledTimes(3);
  });

  it("shares a question that is in flight", async () => {
    const fetchLike = answering(true);
    const reviews = new AccessReviews(fetchLike);
    const [first, second] = await Promise.all([reviews.ask(PATCH_STATUS), reviews.ask(PATCH_STATUS)]);
    expect(first).toBe("allowed");
    expect(second).toBe("allowed");
    expect(fetchLike).toHaveBeenCalledTimes(1);
  });
});

describe("accessGuard", () => {
  it("is enabled until the API server says no", () => {
    expect(accessGuard([PATCH_STATUS, DELETE_PODS], ["unknown", "allowed"])).toEqual({ enabled: true });
    expect(accessGuard([], [])).toEqual({ enabled: true });
  });

  it("names the verb, the resource and the namespace of the first denial", () => {
    expect(accessGuard([DELETE_PODS, PATCH_STATUS], ["allowed", "denied"])).toEqual({
      enabled: false,
      reason: "Your account may not patch clusters/status in db (the API server was asked)",
    });
  });
});
