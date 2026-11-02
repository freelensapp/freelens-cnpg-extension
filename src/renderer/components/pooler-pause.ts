/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pause and resume of a pooler (SPEC-0037): `spec.pgbouncer.paused`, which the
// operator turns into PgBouncer's PAUSE and RESUME. The state, the guards, the
// patch and the facts of the two dialogs. Pure.

import { disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export interface PoolerPauseFacts {
  name: string;
  namespace: string;
  cluster?: string;
  /** `spec.pgbouncer.paused` as declared. */
  paused: boolean;
  /** `status.phase`: `paused` once PgBouncer is. */
  phase?: string;
}

export type PoolerPauseState = "running" | "pausing" | "paused" | "resuming";

/** The declared value against what the operator reports: a request it has not carried out yet shows as such. */
export function poolerPauseState(pooler: PoolerPauseFacts): PoolerPauseState {
  const reported = pooler.phase === "paused";
  if (pooler.paused) return reported ? "paused" : "pausing";
  return reported ? "resuming" : "running";
}

export function poolerPauseWords(state: PoolerPauseState): string {
  switch (state) {
    case "paused":
      return "Paused: PgBouncer holds every new query until the pooler is resumed";
    case "pausing":
      return "Pausing: requested, the operator has not reported it yet";
    case "resuming":
      return "Resuming: requested, the operator has not reported it yet";
    default:
      return "Not paused";
  }
}

export function canPausePooler(pooler: PoolerPauseFacts): ActionGuard {
  return pooler.paused ? disabledGuard("The pooler is paused already") : enabledGuard;
}

export function canResumePooler(pooler: PoolerPauseFacts): ActionGuard {
  return pooler.paused ? enabledGuard : disabledGuard("The pooler is not paused");
}

/** The one merge patch: the value is always sent explicitly. */
export function poolerPausePatch(paused: boolean): { spec: { pgbouncer: { paused: boolean } } } {
  return { spec: { pgbouncer: { paused } } };
}

function patchLine(pooler: PoolerPauseFacts, paused: boolean): string {
  return `patch Pooler ${pooler.namespace}/${pooler.name}: spec.pgbouncer.paused ${pooler.paused} -> ${paused}`;
}

export function pausePoolerFacts(pooler: PoolerPauseFacts): ActionDialogFacts {
  return {
    subject: subjectOf("Pooler", pooler.namespace, pooler.name),
    writes: [{ verb: "patch", text: patchLine(pooler, true) }],
    notes: [
      "PgBouncer lets the queries running now finish, then holds every new one: clients stay connected and wait, nothing is refused.",
      `Nothing changes on the cluster ${pooler.cluster ?? "behind it"}: clients that connect to it directly are not paused.`,
      "The pooler stays paused until it is resumed, also when its pods restart: the pause is in its spec.",
    ],
    warnings: [
      "Applications see their queries hang, not fail: their own timeouts may fire while the pooler is paused.",
    ],
  };
}

export function resumePoolerFacts(pooler: PoolerPauseFacts): ActionDialogFacts {
  return {
    subject: subjectOf("Pooler", pooler.namespace, pooler.name),
    writes: [{ verb: "patch", text: patchLine(pooler, false) }],
    notes: ["PgBouncer sends the queries it held to the cluster, and the new ones as they come."],
    warnings: [],
  };
}

/** The clients connected through the pooler right now, in one sentence for the dialog. */
export function connectedClientsWords(clients: { active: number; waiting: number } | undefined): string {
  if (!clients) return "Reading the clients connected through the pooler";
  const total = clients.active + clients.waiting;
  if (total === 0) return "No client is connected through the pooler right now.";
  return `${total} client${total === 1 ? " is" : "s are"} connected through the pooler right now (${clients.active} active, ${clients.waiting} waiting for a server connection).`;
}
