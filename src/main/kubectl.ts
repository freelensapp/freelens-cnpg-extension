/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What main needs to run kubectl for a Kubernetes cluster, without the host:
// the shape of the host (`kubectl-host.ts` fills it from `Main`), and the
// checks of the names that reach a command line. Pure.

import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface KubectlHost {
  kubectl(clusterId: string): Promise<string>;
  environment(clusterId: string): Promise<Record<string, string>>;
  /** Told the connection status now and whenever it changes, until what it returns is called. */
  watchStatus(clusterId: string, listener: (status: string | undefined) => void): () => void;
  /** The working directory of kubectl: the folder of the extension. */
  cwd(): string;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const CONNECTED = "connected";

/** Kubernetes names main accepts from the renderer before they reach a command line. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && LABEL.test(value);
}

export function isSubdomain(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && SUBDOMAIN.test(value);
}

export function isClusterId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s/\\]/.test(value);
}
