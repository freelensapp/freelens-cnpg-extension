/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The channels between the renderer and main (ARCHITECTURE.md "Process
// model"): the local port forwards of SPEC-0031 and the two files of the
// primary of SPEC-0035. Every one is an `invoke` answered to the frame that
// asked, never a broadcast. Nothing here carries a credential.

export const CNPG_IPC = {
  forwardStart: "cnpg:forward:start",
  forwardStop: "cnpg:forward:stop",
  forwardList: "cnpg:forward:list",
  primaryFiles: "cnpg:primary:files",
} as const;

/** The port of PostgreSQL and PgBouncer behind every service of a cluster or a pooler. */
export const POSTGRES_PORT = 5432;

export interface ForwardStartRequest {
  /** The Kubernetes cluster of the frame, `Renderer.Catalog.getActiveCluster().id`. */
  clusterId: string;
  namespace: string;
  /** The CloudNativePG cluster the service belongs to, for the list of its drawer. */
  cluster: string;
  service: string;
}

export type ForwardState = "starting" | "running" | "ended";

export interface ForwardDto {
  id: string;
  clusterId: string;
  namespace: string;
  cluster: string;
  service: string;
  /** `127.0.0.1` once running. */
  address?: string;
  port?: number;
  /** Epoch milliseconds. */
  startedAt: number;
  state: ForwardState;
  /** Why it ended, in words: stopped, the cluster disconnected, kubectl exited. */
  ended?: string;
}

export interface ForwardStartAnswer {
  forward?: ForwardDto;
  /** Why it did not start, in words; nothing kubectl wrote is in it. */
  error?: string;
}

export interface ForwardStopRequest {
  id: string;
}

export interface ForwardListRequest {
  clusterId: string;
  namespace: string;
  cluster: string;
}

export interface PrimaryFilesRequest {
  clusterId: string;
  namespace: string;
  cluster: string;
  /** The pod the renderer believes is the primary: main checks it against the cluster before running. */
  pod: string;
}

export interface PrimaryFilesAnswer {
  customConf?: string;
  pgHbaConf?: string;
  error?: string;
}
