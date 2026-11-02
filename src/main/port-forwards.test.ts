/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ServiceForwards, startFailure } from "./port-forwards";
import type { ChildProcess } from "node:child_process";

import type { KubectlHost } from "./kubectl";

class FakeKubectl extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4242;
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    // kubectl ends on SIGTERM.
    setImmediate(() => this.end(0));
    return true;
  }

  end(code: number): void {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

function setup(status = "connected") {
  const spawned: Array<{ command: string; args: string[]; child: FakeKubectl }> = [];
  let listener: ((status: string | undefined) => void) | undefined;
  const host: KubectlHost = {
    kubectl: async () => "/k/kubectl",
    environment: async () => ({ HTTPS_PROXY: "http://127.0.0.1:1" }),
    watchStatus: (_id, notify) => {
      listener = notify;
      notify(status);
      return () => {
        listener = undefined;
      };
    },
    cwd: () => "/ext",
  };
  const exitListeners: Array<() => void> = [];
  let ids = 0;
  const forwards = new ServiceForwards(
    host,
    (command, args) => {
      const child = new FakeKubectl();
      spawned.push({ command, args, child });
      return child as unknown as ChildProcess;
    },
    (onExit) => {
      exitListeners.push(onExit);
      return () => undefined;
    },
    () => 1000,
    () => `f${++ids}`,
  );
  return { forwards, spawned, exitListeners, setStatus: (value: string) => listener?.(value) };
}

const REQUEST = { clusterId: "c1", namespace: "cnpg-e2e", cluster: "e2e-main", service: "e2e-main-rw" };

async function ready(spawned: ReturnType<typeof setup>["spawned"], port = 41234) {
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  spawned[0].child.stdout.write(`Forwarding from 127.0.0.1:${port} -> 5432\n`);
}

describe("the local port forwards of main (SPEC-0031)", () => {
  it("runs kubectl port-forward to the service on the loopback, and reads the port it picked", async () => {
    const { forwards, spawned } = setup();
    const started = forwards.start(REQUEST);
    await ready(spawned);
    expect(await started).toEqual({
      forward: {
        id: "f1",
        clusterId: "c1",
        namespace: "cnpg-e2e",
        cluster: "e2e-main",
        service: "e2e-main-rw",
        startedAt: 1000,
        state: "running",
        address: "127.0.0.1",
        port: 41234,
      },
    });
    expect(spawned[0].command).toBe("/k/kubectl");
    expect(spawned[0].args).toEqual([
      "port-forward",
      "--address",
      "127.0.0.1",
      "--namespace",
      "cnpg-e2e",
      "service/e2e-main-rw",
      ":5432",
    ]);
    expect(forwards.list(REQUEST).map((forward) => forward.port)).toEqual([41234]);
    expect(forwards.list({ ...REQUEST, cluster: "other" })).toEqual([]);
  });

  it("refuses names that are not Kubernetes names before anything runs", async () => {
    const { forwards, spawned } = setup();
    expect(await forwards.start({ ...REQUEST, service: "x; rm -rf /" })).toEqual({
      error: "Not a service of a cluster to forward to",
    });
    expect(await forwards.start({ ...REQUEST, clusterId: "" })).toEqual({
      error: "Not a service of a cluster to forward to",
    });
    expect(spawned).toHaveLength(0);
  });

  it("says why kubectl ended before it was ready, in words", async () => {
    const { forwards, spawned } = setup();
    const started = forwards.start(REQUEST);
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0].child.stderr.write(
      'Error from server (Forbidden): pods "x" is forbidden: User "u" cannot create resource "pods/portforward"\n',
    );
    spawned[0].child.end(1);
    expect(await started).toEqual({
      error: "Your account may not create pods/portforward: the port of e2e-main-rw cannot be forwarded",
    });
    expect(forwards.list(REQUEST)).toEqual([]);
    expect(startFailure('Error from server (NotFound): services "x" not found', "x")).toBe(
      "The service x is not there",
    );
    expect(startFailure("error: Unauthorized", "x")).toBe(
      "The Kubernetes cluster did not accept the credential of the connection",
    );
  });

  it("stops a forward on request, and forgets it", async () => {
    const { forwards, spawned } = setup();
    const started = forwards.start(REQUEST);
    await ready(spawned);
    const { forward } = await started;
    const stopped = await forwards.stop(forward?.id ?? "");
    expect(spawned[0].child.signals).toEqual(["SIGTERM"]);
    expect(stopped?.state).toBe("ended");
    expect(stopped?.ended).toBe("Stopped");
    expect(forwards.list(REQUEST)).toEqual([]);
    expect(forwards.running).toBe(0);
  });

  it("keeps a forward whose kubectl exited on its row, ended, never restarted", async () => {
    const { forwards, spawned } = setup();
    const started = forwards.start(REQUEST);
    await ready(spawned);
    await started;
    spawned[0].child.end(1);
    await vi.waitFor(() => expect(forwards.list(REQUEST)[0]?.state).toBe("ended"));
    expect(forwards.list(REQUEST)[0].ended).toBe("kubectl exited");
    expect(spawned).toHaveLength(1);
  });

  it("kills kubectl when the cluster disconnects, the extension is disabled or Freelens quits", async () => {
    const disconnected = setup();
    const first = disconnected.forwards.start(REQUEST);
    await ready(disconnected.spawned);
    await first;
    disconnected.setStatus("disconnected");
    await vi.waitFor(() =>
      expect(disconnected.forwards.list(REQUEST)[0]?.ended).toBe("The Kubernetes cluster disconnected"),
    );

    const disabled = setup();
    const second = disabled.forwards.start(REQUEST);
    await ready(disabled.spawned);
    await second;
    await disabled.forwards.closeAll();
    expect(disabled.spawned[0].child.signals).toEqual(["SIGTERM"]);
    expect(await disabled.forwards.start(REQUEST)).toEqual({ error: "The extension is being disabled" });

    const quitting = setup();
    const third = quitting.forwards.start(REQUEST);
    await ready(quitting.spawned);
    await third;
    for (const listener of quitting.exitListeners) listener();
    expect(quitting.spawned[0].child.signals).toEqual(["SIGTERM"]);
  });

  it("does not start for a cluster that is not connected", async () => {
    const { forwards, spawned } = setup("disconnected");
    const started = forwards.start(REQUEST);
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(await started).toEqual({ error: "The Kubernetes cluster is not connected" });
  });
});
