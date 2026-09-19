/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { parsePrometheusText } from "../api/instance/prometheus-text";
import {
  findOperators,
  imageVersion,
  isLeaderByMetrics,
  kindFacts,
  operatorFacts,
  pluginFacts,
  podsOfDeployment,
  reconcileFacts,
} from "./operator";

import type { DeploymentLike } from "./operator";

const NOW = new Date("2026-09-19T14:10:30Z");

// As observed on the E2E cluster (release manifest of operator 1.30.0).
function operator(overrides: Partial<DeploymentLike> = {}): DeploymentLike {
  return {
    metadata: {
      name: "cnpg-controller-manager",
      namespace: "cnpg-system",
      labels: { "app.kubernetes.io/name": "cloudnative-pg" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": "cloudnative-pg" } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "cloudnative-pg" } },
        spec: {
          containers: [
            {
              name: "manager",
              image: "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0",
              args: [
                "controller",
                "--leader-elect",
                "--max-concurrent-reconciles=10",
                "--config-map-name=cnpg-controller-manager-config",
                "--secret-name=cnpg-controller-manager-config",
                "--webhook-port=9443",
              ],
              env: [
                { name: "OPERATOR_IMAGE_NAME", value: "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0" },
                { name: "OPERATOR_NAMESPACE" },
              ],
              ports: [
                { name: "metrics", containerPort: 8080 },
                { name: "webhook-server", containerPort: 9443 },
              ],
            },
          ],
        },
      },
    },
    status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 },
    ...overrides,
  };
}

const POD = {
  metadata: {
    name: "cnpg-controller-manager-9f5cd66db-ph9nt",
    namespace: "cnpg-system",
    labels: { "app.kubernetes.io/name": "cloudnative-pg" },
  },
};

const LEASE = {
  metadata: { name: "db9c8771.cnpg.io", namespace: "cnpg-system" },
  spec: {
    holderIdentity: "cnpg-controller-manager-9f5cd66db-ph9nt_f5466d82-6f46-4bd8-bb2a-a39efbc40955",
    acquireTime: "2026-09-19T14:09:21.587335Z",
    renewTime: "2026-09-19T14:10:24.004885Z",
    leaseDurationSeconds: 15,
    leaseTransitions: 4,
  },
};

describe("discovery", () => {
  it("finds the operator by its label, its well-known name or its image, and nothing else", () => {
    const byImage: DeploymentLike = {
      metadata: { name: "my-release", namespace: "pg" },
      spec: { template: { spec: { containers: [{ image: "registry.local/mirror/cloudnative-pg@sha256:abc" }] } } },
    };
    const byName: DeploymentLike = { metadata: { name: "cnpg-controller-manager", namespace: "operators" } };
    const plugin: DeploymentLike = {
      metadata: { name: "barman-cloud", namespace: "cnpg-system", labels: { app: "barman-cloud" } },
      spec: { template: { spec: { containers: [{ image: "ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.15.0" }] } } },
    };
    expect(findOperators([plugin, byImage, operator(), byName]).map((item) => item.metadata?.namespace)).toEqual([
      "cnpg-system",
      "operators",
      "pg",
    ]);
  });

  it("reads the version from the image tag", () => {
    expect(imageVersion("ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0")).toBe("1.30.0");
    expect(imageVersion("ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:abc")).toBe("1.30.0");
    expect(imageVersion("registry.local:5000/cnpg/cloudnative-pg:1.29.2")).toBe("1.29.2");
    expect(imageVersion("registry.local:5000/cnpg/cloudnative-pg@sha256:abc")).toBeUndefined();
    expect(imageVersion(undefined)).toBeUndefined();
  });
});

describe("operatorFacts", () => {
  it("reads state, version, leader, flags and the watch scope of the release manifest", () => {
    const facts = operatorFacts({ deployment: operator(), pods: [POD], leases: [LEASE], now: NOW });
    expect(facts).toMatchObject({
      name: "cnpg-controller-manager",
      namespace: "cnpg-system",
      state: "Running",
      className: "success",
      reason: "1 of 1 replicas ready",
      version: "1.30.0",
      ready: 1,
      declared: 1,
      pods: ["cnpg-controller-manager-9f5cd66db-ph9nt"],
      leader: "cnpg-controller-manager-9f5cd66db-ph9nt",
      leaseName: "db9c8771.cnpg.io",
      metricsPort: 8080,
      leaderElection: true,
      maxConcurrentReconciles: "10",
      configMapName: "cnpg-controller-manager-config",
      secretName: "cnpg-controller-manager-config",
      watchScope: "All namespaces",
      configuration: [],
    });
    expect(facts.lease).toMatchObject({ transitions: 4, current: true });
  });

  it("reads the watch scope and the other settings from the config map, which wins over the environment", () => {
    const deployment = operator();
    const container = deployment.spec?.template?.spec?.containers?.[0];
    container?.env?.push({ name: "WATCH_NAMESPACE", value: "ignored" });
    const facts = operatorFacts({
      deployment,
      configMaps: [
        {
          metadata: { name: "cnpg-controller-manager-config", namespace: "cnpg-system" },
          data: { WATCH_NAMESPACE: "team-a, team-b", INHERITED_LABELS: "environment, app" },
        },
        { metadata: { name: "cnpg-controller-manager-config", namespace: "elsewhere" }, data: { X: "y" } },
      ],
    });
    expect(facts.watchScope).toBe("team-a, team-b");
    expect(facts.watchedNamespaces).toEqual(["team-a", "team-b"]);
    expect(facts.configuration).toEqual([{ name: "INHERITED_LABELS", value: "environment, app" }]);
  });

  it("tells a rollout from an operator that is down", () => {
    expect(operatorFacts({ deployment: operator({ spec: { ...operator().spec, replicas: 2 } }) })).toMatchObject({
      state: "Progressing",
      className: "warning",
      reason: "1 of 2 replicas ready",
    });
    expect(operatorFacts({ deployment: operator({ status: {} }) })).toMatchObject({
      state: "Down",
      className: "error",
      reason: "No replica is ready: nothing reconciles the clusters",
    });
    expect(
      operatorFacts({ deployment: operator({ spec: { ...operator().spec, replicas: 0 }, status: {} }) }).reason,
    ).toBe("Scaled to zero: nothing reconciles the clusters");
  });

  it("finds the pods of a deployment by its selector, in its namespace only", () => {
    const elsewhere = { metadata: { ...POD.metadata, namespace: "other" } };
    const stranger = {
      metadata: { name: "barman-cloud-1", namespace: "cnpg-system", labels: { app: "barman-cloud" } },
    };
    expect(podsOfDeployment(operator(), [stranger, elsewhere, POD])).toEqual([POD]);
  });
});

describe("pluginFacts", () => {
  // As observed on the E2E cluster (Barman Cloud plugin v0.15.0).
  const service = {
    metadata: {
      name: "barman-cloud",
      namespace: "cnpg-system",
      labels: { app: "barman-cloud", "cnpg.io/pluginName": "barman-cloud.cloudnative-pg.io" },
      annotations: { "cnpg.io/pluginPort": "9090" },
    },
    spec: { selector: { app: "barman-cloud" } },
  };
  const deployment: DeploymentLike = {
    metadata: { name: "barman-cloud", namespace: "cnpg-system" },
    spec: { replicas: 1, template: { metadata: { labels: { app: "barman-cloud" } } } },
    status: { readyReplicas: 1 },
  };
  const user = new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "e2e-main", namespace: "cnpg-e2e" },
    spec: { instances: 3 },
    status: {
      pluginStatus: [
        {
          name: "barman-cloud.cloudnative-pg.io",
          version: "0.15.0",
          capabilities: ["TYPE_RECONCILER_HOOKS", "TYPE_LIFECYCLE_SERVICE"],
        },
      ],
    },
  } as never);
  const other = new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "plain", namespace: "cnpg-e2e" },
    spec: { instances: 1 },
  } as never);

  it("joins the discovered service with its deployment and with the clusters that loaded it", () => {
    expect(pluginFacts([service, { metadata: { name: "cnpg-webhook-service" } }], [deployment], [other, user])).toEqual(
      [
        {
          name: "barman-cloud.cloudnative-pg.io",
          service: "barman-cloud",
          namespace: "cnpg-system",
          port: "9090",
          deployment: "barman-cloud",
          ready: 1,
          declared: 1,
          className: "success",
          clusters: [{ name: "e2e-main", namespace: "cnpg-e2e", version: "0.15.0" }],
          capabilities: ["TYPE_LIFECYCLE_SERVICE", "TYPE_RECONCILER_HOOKS"],
        },
      ],
    );
  });

  it("says so when the deployment behind it is down or cannot be found", () => {
    expect(pluginFacts([service], [{ ...deployment, status: {} }], [])[0]).toMatchObject({
      className: "error",
      ready: 0,
    });
    expect(pluginFacts([service], [], [])[0]).toMatchObject({ className: "info", deployment: undefined });
  });
});

describe("kindFacts", () => {
  it("lists the kinds of the two groups with their versions and whether there is a view", () => {
    const crds = [
      {
        spec: {
          group: "postgresql.cnpg.io",
          scope: "Namespaced",
          names: { kind: "Cluster" },
          versions: [{ name: "v1", served: true, storage: true }],
        },
      },
      {
        spec: {
          group: "barmancloud.cnpg.io",
          scope: "Namespaced",
          names: { kind: "ObjectStore" },
          versions: [{ name: "v1", served: true, storage: true }],
        },
      },
      {
        spec: {
          group: "postgresql.cnpg.io",
          scope: "Cluster",
          names: { kind: "SomethingNew" },
          versions: [
            { name: "v1alpha1", served: false, storage: false },
            { name: "v1", served: true, storage: true },
          ],
        },
      },
      { spec: { group: "cert-manager.io", names: { kind: "Certificate" }, versions: [{ name: "v1" }] } },
    ];
    expect(kindFacts(crds)).toEqual([
      {
        kind: "Cluster",
        group: "postgresql.cnpg.io",
        scope: "Namespaced",
        served: ["v1"],
        stored: "v1",
        hasView: true,
      },
      {
        kind: "SomethingNew",
        group: "postgresql.cnpg.io",
        scope: "Cluster",
        served: ["v1"],
        stored: "v1",
        hasView: false,
      },
      {
        kind: "ObjectStore",
        group: "barmancloud.cnpg.io",
        scope: "Namespaced",
        served: ["v1"],
        stored: "v1",
        hasView: true,
      },
    ]);
  });
});

describe("reconcileFacts", () => {
  const reading = (clusterTotal: number, clusterErrors: number) =>
    parsePrometheusText(`
controller_runtime_reconcile_total{controller="cluster",result="success"} ${clusterTotal - clusterErrors}
controller_runtime_reconcile_total{controller="cluster",result="error"} ${clusterErrors}
controller_runtime_reconcile_total{controller="backup",result="success"} 40
controller_runtime_reconcile_errors_total{controller="cluster"} ${clusterErrors}
controller_runtime_reconcile_errors_total{controller="backup"} 0
controller_runtime_active_workers{controller="cluster"} 1
controller_runtime_max_concurrent_reconciles{controller="cluster"} 10
workqueue_depth{name="cluster"} 2
leader_election_master_status{name="db9c8771.cnpg.io"} 1
`);

  it("sums the results per controller on a first reading, without a pace", () => {
    expect(reconcileFacts(reading(100, 3))).toEqual([
      { controller: "backup", total: 40, errors: 0, level: "ok" },
      { controller: "cluster", total: 100, errors: 3, activeWorkers: 1, maxWorkers: 10, queueDepth: 2, level: "ok" },
    ]);
  });

  it("paces reconciles and errors between two readings and raises the level while errors grow", () => {
    const rows = reconcileFacts(reading(130, 5), reading(100, 3), 30);
    expect(rows.find((row) => row.controller === "cluster")).toMatchObject({
      perMinute: 60,
      errorsPerMinute: 4,
      level: "error",
    });
    expect(rows.find((row) => row.controller === "backup")).toMatchObject({
      perMinute: 0,
      errorsPerMinute: 0,
      level: "ok",
    });
  });

  it("gives no pace across a restart of the operator, when the counters went back", () => {
    expect(
      reconcileFacts(reading(10, 0), reading(100, 3), 30).find((row) => row.controller === "cluster"),
    ).toMatchObject({
      perMinute: undefined,
      errorsPerMinute: undefined,
      level: "ok",
    });
  });

  it("knows whether the pod that answered is the leader", () => {
    expect(isLeaderByMetrics(reading(1, 0))).toBe(true);
    expect(isLeaderByMetrics([])).toBeUndefined();
  });
});
