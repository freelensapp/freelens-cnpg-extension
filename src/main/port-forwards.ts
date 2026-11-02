/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The local port forwards of SPEC-0031: `kubectl port-forward --address
// 127.0.0.1 --namespace <namespace> service/<service> :5432`, run by main with
// the host's kubectl and environment (`kubectl-host.ts`). kubectl picks a free
// local port and writes it in its line of readiness, `Forwarding from
// 127.0.0.1:<port> -> 5432`. Adapted from the tunnels of
// freelens-kafka-extension.
//
// No forward outlives what it was opened for: kubectl is killed when the user
// stops it, when the Kubernetes cluster leaves the connected state, when the
// extension is deactivated (`closeAll`) and when the process exits. A kubectl
// that exits on its own is reported on its row, never restarted.

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { POSTGRES_PORT } from "../common/ipc";
import { CONNECTED, isClusterId, isLabel } from "./kubectl";
import type { ChildProcess } from "node:child_process";

import type { ForwardDto, ForwardListRequest, ForwardStartAnswer, ForwardStartRequest } from "../common/ipc";
import type { KubectlHost, Spawn } from "./kubectl";

export const FORWARD_BOUNDS = {
  /** From the start of kubectl to its line of readiness. */
  readyMs: 20_000,
  /** From the moment kubectl is told to end to the moment it is killed for good. */
  exitMs: 5_000,
} as const;

const LOOPBACK = "127.0.0.1";
const READY = /^Forwarding from 127\.0\.0\.1:(\d+) -> /m;
const PORT_FORWARD_REFUSED = /cannot create resource "pods\/portforward"/;
const UNAUTHORIZED = /\bUnauthorized\b/;
const NOT_FOUND = /services? "[^"]*" not found/;
const NO_POD = /no (?:ready )?pods? (?:available|found)|does not have any (?:running )?pods|unable to find a pod/i;
const KEPT = 16 * 1024;

function kept(text: string): string {
  return text.length > KEPT ? text.slice(text.length - KEPT) : text;
}

/** Why kubectl ended before its line of readiness, in words; nothing kubectl wrote is repeated. */
export function startFailure(written: string, service: string): string {
  if (PORT_FORWARD_REFUSED.test(written)) {
    return `Your account may not create pods/portforward: the port of ${service} cannot be forwarded`;
  }
  if (UNAUTHORIZED.test(written)) return "The Kubernetes cluster did not accept the credential of the connection";
  if (NOT_FOUND.test(written)) return `The service ${service} is not there`;
  if (NO_POD.test(written)) return `The service ${service} has no running pod to forward to`;
  return `kubectl port-forward to ${service} ended before it was ready`;
}

interface Entry {
  dto: ForwardDto;
  stop(reason: string): Promise<void>;
}

export class ServiceForwards {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private unhook?: () => void;

  constructor(
    private readonly host: KubectlHost,
    private readonly spawn: Spawn = spawnProcess,
    private readonly onExit: (listener: () => void) => () => void = (listener) => {
      process.once("exit", listener);
      return () => process.removeListener("exit", listener);
    },
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** The forwards of one CloudNativePG cluster, running and ended, oldest first. */
  list(request: ForwardListRequest): ForwardDto[] {
    return [...this.entries.values()]
      .map((entry) => entry.dto)
      .filter(
        (dto) =>
          dto.clusterId === request?.clusterId &&
          dto.namespace === request?.namespace &&
          dto.cluster === request?.cluster,
      )
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((dto) => ({ ...dto }));
  }

  /** How many kubectl of the extension are still running. */
  get running(): number {
    return [...this.entries.values()].filter((entry) => entry.dto.state !== "ended").length;
  }

  /** Stops a running forward, or forgets an ended one. */
  async stop(id: string): Promise<ForwardDto | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    await entry.stop("Stopped");
    this.entries.delete(id);
    return { ...entry.dto };
  }

  /** Every kubectl told to end, and no other started: the extension is deactivated. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map((entry) => entry.stop("The extension was disabled")));
    this.entries.clear();
    this.unhook?.();
    this.unhook = undefined;
  }

  async start(request: ForwardStartRequest): Promise<ForwardStartAnswer> {
    if (this.closed) return { error: "The extension is being disabled" };
    if (
      !isClusterId(request?.clusterId) ||
      !isLabel(request.namespace) ||
      !isLabel(request.cluster) ||
      !isLabel(request.service)
    ) {
      return { error: "Not a service of a cluster to forward to" };
    }
    let kubectl: string;
    let environment: Record<string, string>;
    try {
      [kubectl, environment] = await Promise.all([
        this.host.kubectl(request.clusterId),
        this.host.environment(request.clusterId),
      ]);
    } catch {
      return { error: "The Kubernetes cluster is not connected" };
    }
    if (this.closed) return { error: "The extension is being disabled" };
    let child: ChildProcess;
    try {
      child = this.spawn(
        kubectl,
        [
          "port-forward",
          "--address",
          LOOPBACK,
          "--namespace",
          request.namespace,
          `service/${request.service}`,
          `:${POSTGRES_PORT}`,
        ],
        { cwd: this.host.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch {
      return { error: "kubectl could not be started" };
    }
    return this.follow(child, request);
  }

  private hook(): void {
    if (this.unhook) return;
    this.unhook = this.onExit(() => {
      for (const entry of this.entries.values()) void entry.stop("Freelens quit");
    });
  }

  private follow(child: ChildProcess, request: ForwardStartRequest): Promise<ForwardStartAnswer> {
    const dto: ForwardDto = {
      id: this.newId(),
      clusterId: request.clusterId,
      namespace: request.namespace,
      cluster: request.cluster,
      service: request.service,
      startedAt: this.now(),
      state: "starting",
    };
    let exited = false;
    let endReason: string | undefined;
    const ended = new Promise<void>((resolve) => {
      child.once("exit", () => {
        exited = true;
        resolve();
      });
      child.once("error", () => {
        if (child.pid !== undefined) return;
        exited = true;
        resolve();
      });
    });
    let stopping: Promise<void> | undefined;
    const stop = (reason: string): Promise<void> => {
      endReason ??= reason;
      stopping ??= (async () => {
        if (exited) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // It ended already.
        }
        let late: ReturnType<typeof setTimeout> | undefined;
        const inTime = await Promise.race([
          ended.then(() => true),
          new Promise<false>((resolve) => {
            late = setTimeout(() => resolve(false), FORWARD_BOUNDS.exitMs);
          }),
        ]);
        clearTimeout(late);
        if (!inTime) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Nothing more can be done of it.
          }
        }
      })();
      return stopping;
    };
    const entry: Entry = { dto, stop };
    let unwatch: () => void = () => undefined;

    this.entries.set(dto.id, entry);
    this.hook();
    void ended.then(() => {
      unwatch();
      dto.state = "ended";
      dto.ended = endReason ?? "kubectl exited";
    });

    return new Promise<ForwardStartAnswer>((resolve) => {
      let settled = false;
      let stdout = "";
      let written = "";
      const fail = (error: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.entries.delete(dto.id);
          resolve({ error });
        }
        void stop(error);
      };
      const timer = setTimeout(
        () => fail(`kubectl port-forward to ${request.service} was not ready within ${FORWARD_BOUNDS.readyMs / 1000}s`),
        FORWARD_BOUNDS.readyMs,
      );
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        stdout = kept(stdout + String(chunk));
        const line = READY.exec(stdout);
        if (!line) return;
        const port = Number(line[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(`kubectl port-forward to ${request.service} gave no usable port`);
          return;
        }
        settled = true;
        clearTimeout(timer);
        dto.state = "running";
        dto.address = LOOPBACK;
        dto.port = port;
        resolve({ forward: { ...dto } });
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (!settled) written = kept(written + String(chunk));
      });
      child.once("error", () => fail("kubectl could not be started"));
      child.once("close", () => {
        if (!settled) fail(this.closed ? "The extension is being disabled" : startFailure(written, request.service));
      });
      try {
        unwatch = this.host.watchStatus(request.clusterId, (status) => {
          if (status === CONNECTED) return;
          if (settled) void stop("The Kubernetes cluster disconnected");
          else fail("The Kubernetes cluster is not connected");
        });
      } catch {
        fail("The status of the Kubernetes cluster could not be followed");
      }
      if (exited) unwatch();
    });
  }
}
