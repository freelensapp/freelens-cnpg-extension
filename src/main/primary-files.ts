/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The two files of the primary that `kubectl cnpg status -v -v` prints
// (v1.30.1, `internal/cmd/plugin/status/status.go`): `custom.conf` and
// `pg_hba.conf` in PGDATA, read with `cat` in the `postgres` container
// (SPEC-0035). Main checks the pod against the cluster's
// `status.currentPrimary` first; the commands are fixed, only the names of the
// namespace, the cluster and the pod reach them, checked as Kubernetes names.

import { execFile } from "node:child_process";
import { isClusterId, isLabel, isSubdomain } from "./kubectl";

import type { PrimaryFilesAnswer, PrimaryFilesRequest } from "../common/ipc";
import type { KubectlHost } from "./kubectl";

export const PGDATA = "/var/lib/postgresql/data/pgdata";
export const PRIMARY_FILES_BOUNDS = { timeoutMs: 20_000, maxBytes: 1024 * 1024 } as const;

export interface KubectlRun {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunKubectl = (
  kubectl: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
) => Promise<KubectlRun>;

export const runKubectl: RunKubectl = (kubectl, args, { env, cwd }) =>
  new Promise((resolve) => {
    execFile(
      kubectl,
      args,
      {
        env,
        cwd,
        timeout: PRIMARY_FILES_BOUNDS.timeoutMs,
        maxBuffer: PRIMARY_FILES_BOUNDS.maxBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The command lines main runs, in order. */
export function primaryFilesCommands(request: PrimaryFilesRequest): string[][] {
  const { namespace, cluster, pod } = request;
  const cat = (file: string) => [
    "exec",
    "--namespace",
    namespace,
    pod,
    "--container",
    "postgres",
    "--",
    "cat",
    `${PGDATA}/${file}`,
  ];
  return [
    [
      "get",
      "clusters.postgresql.cnpg.io",
      cluster,
      "--namespace",
      namespace,
      "--output",
      "jsonpath={.status.currentPrimary}",
    ],
    cat("custom.conf"),
    cat("pg_hba.conf"),
  ];
}

/** Why a command failed, in words; nothing kubectl wrote is repeated. */
export function runFailure(run: KubectlRun, what: string): string {
  if (/cannot create resource "pods\/exec"/.test(run.stderr)) {
    return "Your account may not create pods/exec: the files of the primary cannot be read";
  }
  if (/cannot get resource "clusters"/.test(run.stderr)) return "Your account may not get the cluster";
  if (/\bUnauthorized\b/.test(run.stderr))
    return "The Kubernetes cluster did not accept the credential of the connection";
  if (/not found/.test(run.stderr)) return `${what}: not found`;
  return `${what}: kubectl ended with code ${run.code}`;
}

export async function readPrimaryFiles(
  host: KubectlHost,
  request: PrimaryFilesRequest,
  run: RunKubectl = runKubectl,
): Promise<PrimaryFilesAnswer> {
  if (
    !isClusterId(request?.clusterId) ||
    !isLabel(request.namespace) ||
    !isLabel(request.cluster) ||
    !isSubdomain(request.pod)
  ) {
    return { error: "Not the primary of a cluster to read from" };
  }
  let kubectl: string;
  let env: Record<string, string>;
  try {
    [kubectl, env] = await Promise.all([host.kubectl(request.clusterId), host.environment(request.clusterId)]);
  } catch {
    return { error: "The Kubernetes cluster is not connected" };
  }
  const options = { env, cwd: host.cwd() };
  const [primaryCommand, customCommand, hbaCommand] = primaryFilesCommands(request);
  const primary = await run(kubectl, primaryCommand, options);
  if (primary.code !== 0) return { error: runFailure(primary, `The cluster ${request.cluster}`) };
  if (primary.stdout.trim() !== request.pod) {
    return { error: `${request.pod} is not the primary of ${request.cluster} anymore: read again` };
  }
  const [custom, hba] = await Promise.all([run(kubectl, customCommand, options), run(kubectl, hbaCommand, options)]);
  if (custom.code !== 0) return { error: runFailure(custom, "custom.conf") };
  if (hba.code !== 0) return { error: runFailure(hba, "pg_hba.conf") };
  return { customConf: custom.stdout, pgHbaConf: hba.stdout };
}
