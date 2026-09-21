/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// W3 of SPEC-0020: before a write action is offered, the API server is asked
// whether the user may perform it (`SelfSubjectAccessReview`: the review is
// evaluated and answered, nothing is stored). One question per verb, resource
// and namespace, remembered for a minute.
//
// A denial disables the action with a reason. Everything else (the review
// itself forbidden, the request failing, no answer yet) leaves the action
// enabled: a read that fails never blocks a write the user may be allowed to
// make, and the write reports its own 403 if it comes to that (W9).

import React from "react";
import { API_KUBE_PREFIX, REQUEST_TIMEOUT_MS } from "../api/instance/pod-proxy";
import { disabledGuard, enabledGuard } from "./write-actions";

import type { ActionGuard } from "./write-actions";

export const ACCESS_REVIEW_PATH = `${API_KUBE_PREFIX}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`;
export const ACCESS_REVIEW_TTL_MS = 60_000;

/** What the user must be allowed to do for an action to make sense. */
export interface AccessQuestion {
  verb: "create" | "patch" | "delete";
  /** API group, empty for the core group. */
  group: string;
  resource: string;
  subresource?: string;
  namespace: string;
}

export type AccessAnswer = "allowed" | "denied" | "unknown";

/** The slice of `fetch` the review needs, so tests can stand in for it. */
export type ReviewFetch = (
  url: string,
  init: { method: "POST"; signal: AbortSignal; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export function accessKey(question: AccessQuestion): string {
  const resource = question.subresource ? `${question.resource}/${question.subresource}` : question.resource;
  return `${question.namespace}|${question.group}|${resource}|${question.verb}`;
}

/** `clusters/status` and `pods`, as RBAC spells them. */
export function resourceWords(question: AccessQuestion): string {
  return question.subresource ? `${question.resource}/${question.subresource}` : question.resource;
}

export function reviewBody(question: AccessQuestion): Record<string, unknown> {
  return {
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectAccessReview",
    spec: {
      resourceAttributes: {
        namespace: question.namespace,
        verb: question.verb,
        group: question.group,
        resource: question.resource,
        ...(question.subresource ? { subresource: question.subresource } : {}),
      },
    },
  };
}

function readAnswer(body: unknown): AccessAnswer {
  if (typeof body !== "object" || body === null) return "unknown";
  const status = (body as { status?: { allowed?: unknown } }).status;
  if (status?.allowed === true) return "allowed";
  if (status?.allowed === false) return "denied";
  return "unknown";
}

interface CacheEntry {
  answer: AccessAnswer;
  at: number;
  pending?: Promise<AccessAnswer>;
}

/** The reviews of one cluster frame: a cache over an injected `fetch` and clock. */
export class AccessReviews {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchLike: ReviewFetch,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = ACCESS_REVIEW_TTL_MS,
  ) {}

  /** What is known right now, without asking. */
  peek(question: AccessQuestion): AccessAnswer {
    const entry = this.entries.get(accessKey(question));
    if (!entry || this.expired(entry)) return "unknown";
    return entry.answer;
  }

  /** Asks the API server, unless a fresh answer or a question in flight is there already. */
  ask(question: AccessQuestion): Promise<AccessAnswer> {
    const key = accessKey(question);
    const entry = this.entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && !this.expired(entry)) return Promise.resolve(entry.answer);

    const pending = this.request(question).then((answer) => {
      this.entries.set(key, { answer, at: this.now() });
      return answer;
    });
    this.entries.set(key, { answer: entry?.answer ?? "unknown", at: entry?.at ?? 0, pending });
    return pending;
  }

  private expired(entry: CacheEntry): boolean {
    return this.now() - entry.at >= this.ttlMs;
  }

  private async request(question: AccessQuestion): Promise<AccessAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchLike(ACCESS_REVIEW_PATH, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(reviewBody(question)),
      });
      if (response.status < 200 || response.status >= 300) return "unknown";
      return readAnswer(await response.json());
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The guard of W3 over a set of answers: the first denial, with the verb and the resource in its reason. */
export function accessGuard(questions: readonly AccessQuestion[], answers: readonly AccessAnswer[]): ActionGuard {
  const index = answers.indexOf("denied");
  if (index < 0) return enabledGuard;
  const question = questions[index];
  return disabledGuard(
    `Your account may not ${question.verb} ${resourceWords(question)} in ${question.namespace} (the API server was asked)`,
  );
}

let shared: AccessReviews | undefined;

/** The reviews of this cluster frame, over the frame's own `fetch`. */
export function sharedAccessReviews(): AccessReviews {
  shared ??= new AccessReviews((url, init) => fetch(url, init));
  return shared;
}

/**
 * The guard of W3 for a component: enabled until the API server says no. The
 * questions are asked when the component mounts and whenever they change.
 */
export function useAccessGuard(questions: readonly AccessQuestion[], reviews?: AccessReviews): ActionGuard {
  const source = reviews ?? sharedAccessReviews();
  const key = questions.map(accessKey).join(";");
  const [, setTick] = React.useState(0);

  // `key` is the identity of `questions`: the array itself is new on every render.
  React.useEffect(() => {
    let mounted = true;
    Promise.all(questions.map((question) => source.ask(question))).then(() => {
      if (mounted) setTick((tick) => tick + 1);
    });
    return () => {
      mounted = false;
    };
  }, [key, source]);

  return accessGuard(
    questions,
    questions.map((question) => source.peek(question)),
  );
}
