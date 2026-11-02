/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { primaryFilesCommands, readPrimaryFiles } from "./primary-files";

import type { KubectlHost } from "./kubectl";
import type { KubectlRun } from "./primary-files";

const HOST: KubectlHost = {
  kubectl: async () => "/k/kubectl",
  environment: async () => ({}),
  watchStatus: () => () => undefined,
  cwd: () => "/ext",
};
const REQUEST = { clusterId: "c1", namespace: "cnpg-e2e", cluster: "e2e-main", pod: "e2e-main-1" };

function runner(answers: Record<string, KubectlRun>) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_kubectl: string, args: string[]) => {
      calls.push(args);
      const key = args[0] === "get" ? "get" : ((args.at(-1) ?? "").split("/").at(-1) ?? "");
      return answers[key] ?? { code: 1, stdout: "", stderr: "" };
    },
  };
}

describe("the files of the primary (SPEC-0035)", () => {
  it("checks the primary, then runs the two fixed cat commands of kubectl cnpg status", async () => {
    const { calls, run } = runner({
      get: { code: 0, stdout: "e2e-main-1", stderr: "" },
      "custom.conf": { code: 0, stdout: "port = '5432'\n", stderr: "" },
      "pg_hba.conf": { code: 0, stdout: "host all all all scram-sha-256\n", stderr: "" },
    });
    expect(await readPrimaryFiles(HOST, REQUEST, run)).toEqual({
      customConf: "port = '5432'\n",
      pgHbaConf: "host all all all scram-sha-256\n",
    });
    expect(calls).toEqual(primaryFilesCommands(REQUEST));
    expect(calls[1]).toEqual([
      "exec",
      "--namespace",
      "cnpg-e2e",
      "e2e-main-1",
      "--container",
      "postgres",
      "--",
      "cat",
      "/var/lib/postgresql/data/pgdata/custom.conf",
    ]);
  });

  it("refuses a pod that is not the current primary, and runs nothing on it", async () => {
    const { calls, run } = runner({ get: { code: 0, stdout: "e2e-main-2", stderr: "" } });
    expect(await readPrimaryFiles(HOST, REQUEST, run)).toEqual({
      error: "e2e-main-1 is not the primary of e2e-main anymore: read again",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses names that are not Kubernetes names, and says a missing permission in words", async () => {
    const { calls, run } = runner({});
    expect(await readPrimaryFiles(HOST, { ...REQUEST, pod: "e2e-main-1 --all" }, run)).toEqual({
      error: "Not the primary of a cluster to read from",
    });
    expect(calls).toHaveLength(0);
    const denied = runner({
      get: { code: 0, stdout: "e2e-main-1", stderr: "" },
      "custom.conf": { code: 1, stdout: "", stderr: 'User "u" cannot create resource "pods/exec" in API group ""' },
      "pg_hba.conf": { code: 0, stdout: "", stderr: "" },
    });
    expect(await readPrimaryFiles(HOST, REQUEST, denied.run)).toEqual({
      error: "Your account may not create pods/exec: the files of the primary cannot be read",
    });
  });
});
