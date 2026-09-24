/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  catalogKey,
  clusterCreateBlockReason,
  clusterCreateBody,
  clusterCreateFacts,
  clusterCreateNotes,
  clusterCreateWarnings,
  clusterEffectiveValues,
  clusterFormErrors,
  clusterFormWarnings,
  defaultClusterForm,
  emptyClusterCreateInputs,
  emptyTablespaceRow,
  tablespaceNameError,
  tablespaceVolumeName,
} from "./cluster-create";
import { toYaml } from "./create-forms";

import type { ClusterCreateInputs, ClusterForm } from "./cluster-create";

const READY: ClusterCreateInputs = {
  selectedNamespaces: ["db"],
  clusters: ["pg-old"],
  objectStores: ["minio-store"],
  catalogs: [
    { kind: "ImageCatalog", name: "postgres", majors: [16, 17] },
    { kind: "ClusterImageCatalog", name: "company", majors: [18] },
  ],
  storageClasses: ["standard", "fast"],
  secrets: [
    { name: "app-creds", type: "kubernetes.io/basic-auth", username: "app" },
    { name: "tls-thing", type: "kubernetes.io/tls" },
  ],
  backups: [
    { name: "pg-old-20260920174036", cluster: "pg-old", phase: "completed" },
    { name: "pg-old-pending", cluster: "pg-old", phase: "pending" },
  ],
  snapshotClasses: [{ name: "csi-hostpath-snapclass", driver: "hostpath.csi.k8s.io" }],
  volumeSnapshots: [
    {
      name: "snap-ok",
      role: "PG_DATA",
      backup: "snap-ok",
      cluster: "pg-old",
      date: "2026-09-24",
      hot: false,
      ready: true,
    },
    {
      name: "snap-ok-wal",
      role: "PG_WAL",
      backup: "snap-ok",
      cluster: "pg-old",
      date: "2026-09-24",
      hot: false,
      ready: true,
    },
    {
      name: "snap-ok-tbs-analytics",
      role: "PG_TABLESPACE",
      tablespace: "analytics",
      backup: "snap-ok",
      cluster: "pg-old",
      date: "2026-09-24",
      hot: false,
      ready: true,
    },
    {
      name: "snap-hot",
      role: "PG_DATA",
      backup: "snap-hot",
      cluster: "pg-old",
      date: "2026-09-23",
      hot: true,
      ready: true,
    },
    { name: "snap-pending", role: "PG_DATA", backup: "snap-pending", cluster: "pg-old", hot: false, ready: false },
    { name: "someone-else", ready: true },
  ],
  volumeSnapshotCrd: true,
  operatorImage: "ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie",
  reads: {
    clusters: "ready",
    objectStores: "ready",
    catalogs: "ready",
    storageClasses: "ready",
    secrets: "ready",
    backups: "ready",
    snapshotClasses: "ready",
    volumeSnapshots: "ready",
    crds: "ready",
  },
};

function filled(overrides: Partial<ClusterForm> = {}): ClusterForm {
  return { ...defaultClusterForm("db"), name: "pg", storageSize: "10Gi", objectStore: "minio-store", ...overrides };
}

describe("the default form", () => {
  it("ships the recommended shape and asks for what it cannot guess", () => {
    const form = defaultClusterForm("db");
    expect(form.instances).toBe("3");
    expect(form.bootstrap).toBe("initdb");
    expect(form.initdbDatabase).toBe("app");
    expect(form.imageSource).toBe("operator");
    expect(clusterCreateBlockReason(READY, form)).toBe("A name is required");
    expect(clusterCreateBlockReason(READY, { ...form, name: "pg" })).toBe("A storage size is required");
    expect(clusterCreateBlockReason(READY, filled())).toBeUndefined();
    expect(clusterCreateBlockReason(emptyClusterCreateInputs(), { ...filled(), namespace: "" })).toBe(
      "A namespace is required",
    );
  });

  it("shows the effective values and never sends them", () => {
    expect(clusterEffectiveValues(READY).image).toBe("ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie");
    expect(clusterEffectiveValues(emptyClusterCreateInputs()).image).toBe("the operator's default image");
    const body = clusterCreateBody(filled()) as { spec: Record<string, unknown> };
    expect(body.spec.primaryUpdateStrategy).toBeUndefined();
    expect(body.spec.enableSuperuserAccess).toBeUndefined();
    expect(body.spec.imageName).toBeUndefined();
    expect(body.spec.backup).toBeUndefined();
  });
});

describe("the body", () => {
  it("is the minimal recommended cluster with plugin archiving", () => {
    expect(clusterCreateBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: "pg", namespace: "db" },
      spec: {
        instances: 3,
        storage: { size: "10Gi" },
        bootstrap: { initdb: { database: "app", owner: "app" } },
        plugins: [
          {
            name: "barman-cloud.cloudnative-pg.io",
            isWALArchiver: true,
            parameters: { barmanObjectName: "minio-store" },
          },
        ],
      },
    });
  });

  it("serializes in the order of the form", () => {
    expect(toYaml(clusterCreateBody(filled({ description: "main", storageClass: "fast" })))).toBe(
      [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Cluster",
        "metadata:",
        "  name: pg",
        "  namespace: db",
        "spec:",
        "  description: main",
        "  instances: 3",
        "  storage:",
        "    size: 10Gi",
        "    storageClass: fast",
        "  bootstrap:",
        "    initdb:",
        "      database: app",
        "      owner: app",
        "  plugins:",
        "    - name: barman-cloud.cloudnative-pg.io",
        "      isWALArchiver: true",
        "      parameters:",
        "        barmanObjectName: minio-store",
        "",
      ].join("\n"),
    );
  });

  it("carries the image choice, the WAL volume and the options of initdb", () => {
    const catalog = clusterCreateBody(
      filled({
        imageSource: "catalog",
        catalog: "ClusterImageCatalog/company",
        catalogMajor: "18",
        walEnabled: true,
        walSize: "2Gi",
        walClass: "fast",
      }),
    ) as { spec: Record<string, unknown> };
    expect(catalog.spec.imageCatalogRef).toEqual({
      apiGroup: "postgresql.cnpg.io",
      kind: "ClusterImageCatalog",
      name: "company",
      major: 18,
    });
    expect(catalog.spec.walStorage).toEqual({ size: "2Gi", storageClass: "fast" });
    const named = clusterCreateBody(
      filled({
        imageSource: "name",
        imageName: "ghcr.io/cloudnative-pg/postgresql:17.2",
        initdbSecret: "app-creds",
        initdbEncoding: "UTF8",
        initdbLocaleProvider: "icu",
        initdbLocale: "en-US",
        initdbDataChecksums: true,
      }),
    ) as { spec: { imageName: string; bootstrap: { initdb: Record<string, unknown> } } };
    expect(named.spec.imageName).toBe("ghcr.io/cloudnative-pg/postgresql:17.2");
    expect(named.spec.bootstrap.initdb).toEqual({
      database: "app",
      owner: "app",
      secret: { name: "app-creds" },
      encoding: "UTF8",
      localeProvider: "icu",
      icuLocale: "en-US",
      dataChecksums: true,
    });
    const builtin = clusterCreateBody(filled({ initdbLocaleProvider: "builtin", initdbLocale: "C.UTF-8" })) as {
      spec: { bootstrap: { initdb: Record<string, unknown> } };
    };
    expect(builtin.spec.bootstrap.initdb.builtinLocale).toBe("C.UTF-8");
  });

  it("recovers from a backup, or from an object store through an external cluster", () => {
    const fromBackup = clusterCreateBody(
      filled({
        bootstrap: "recovery",
        recoverySource: "backup",
        recoveryBackup: "pg-old-20260920174036",
        recoveryTargetTime: "2026-09-21T10:00:00Z",
      }),
    ) as { spec: Record<string, unknown> };
    expect(fromBackup.spec.bootstrap).toEqual({
      recovery: { backup: { name: "pg-old-20260920174036" }, recoveryTarget: { targetTime: "2026-09-21T10:00:00Z" } },
    });
    expect(fromBackup.spec.externalClusters).toBeUndefined();
    const fromStore = clusterCreateBody(
      filled({
        bootstrap: "recovery",
        recoverySource: "objectStore",
        recoveryObjectStore: "minio-store",
        recoveryServerName: "pg-old",
      }),
    ) as { spec: Record<string, unknown> };
    expect(fromStore.spec.bootstrap).toEqual({ recovery: { source: "pg-old" } });
    expect(fromStore.spec.externalClusters).toEqual([
      {
        name: "pg-old",
        plugin: {
          name: "barman-cloud.cloudnative-pg.io",
          parameters: { barmanObjectName: "minio-store", serverName: "pg-old" },
        },
      },
    ]);
  });

  it("carries the rest only when set", () => {
    const body = clusterCreateBody(
      filled({
        backupTarget: "primary",
        superuserAccess: true,
        superuserSecret: "su",
        syncEnabled: true,
        syncMethod: "first",
        syncNumber: "1",
        syncDurability: "preferred",
        requestsCpu: "500m",
        requestsMemory: "1Gi",
        limitsCpu: "1",
        limitsMemory: "1Gi",
        updateStrategy: "supervised",
        updateMethod: "switchover",
        parameters: [
          { key: "shared_buffers", value: "256MB" },
          { key: " ", value: "ignored" },
        ],
        antiAffinity: "required",
        topologyKey: "topology.kubernetes.io/zone",
        nodeSelector: [{ key: "disk", value: "ssd" }],
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec.backup).toEqual({ target: "primary" });
    expect(body.spec.enableSuperuserAccess).toBe(true);
    expect(body.spec.superuserSecret).toEqual({ name: "su" });
    expect(body.spec.postgresql).toEqual({
      synchronous: { method: "first", number: 1, dataDurability: "preferred" },
      parameters: { shared_buffers: "256MB" },
    });
    expect(body.spec.resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "1", memory: "1Gi" },
    });
    expect(body.spec.primaryUpdateStrategy).toBe("supervised");
    expect(body.spec.primaryUpdateMethod).toBe("switchover");
    expect(body.spec.affinity).toEqual({
      podAntiAffinityType: "required",
      topologyKey: "topology.kubernetes.io/zone",
      nodeSelector: { disk: "ssd" },
    });
  });
});

describe("the errors", () => {
  it("enforce the rules of the operator's admission inline", () => {
    expect(clusterFormErrors(READY, filled({ name: "a".repeat(51) })).name).toBe("A name has 50 characters at most");
    expect(clusterFormErrors(READY, filled({ name: "1pg" })).name).toMatch(/starts with a letter/);
    expect(clusterFormErrors(READY, filled({ instances: "0" })).instances).toBe("Instances is 1 or more");
    expect(clusterFormErrors(READY, filled({ instances: "1", updateStrategy: "supervised" })).updateStrategy).toMatch(
      /one instance/,
    );
    expect(clusterFormErrors(READY, filled({ syncEnabled: true, syncNumber: "3" })).syncNumber).toMatch(
      /below the instances \(3\)/,
    );
    expect(clusterFormErrors(READY, filled({ syncEnabled: true, syncNumber: "2" })).syncNumber).toBeUndefined();
    expect(clusterFormErrors(READY, filled({ imageSource: "name", imageName: "postgres:latest" })).imageName).toMatch(
      /latest/,
    );
    expect(clusterFormErrors(READY, filled({ imageSource: "catalog" })).catalog).toBe("Pick a catalog");
    expect(
      clusterFormErrors(READY, filled({ imageSource: "catalog", catalog: "ImageCatalog/postgres", catalogMajor: "18" }))
        .catalogMajor,
    ).toBe("postgres lists no image for PostgreSQL 18");
    expect(clusterFormErrors(READY, filled({ storageSize: "0" })).storageSize).toBe("A storage size is above zero");
    expect(clusterFormErrors(READY, filled({ walEnabled: true })).walSize).toBe("A WAL volume size is required");
    expect(clusterFormErrors(READY, filled({ initdbDatabase: "1db" })).initdbDatabase).toMatch(/digit/);
    expect(clusterFormErrors(READY, filled({ initdbLocaleProvider: "icu" })).initdbLocale).toMatch(/icu provider/);
    expect(clusterFormErrors(READY, filled({ initdbLocaleProvider: "libc" })).initdbLocale).toBeUndefined();
  });

  it("check the resources against each other and against shared_buffers", () => {
    expect(clusterFormErrors(READY, filled({ requestsCpu: "2", limitsCpu: "1" })).limitsCpu).toBe(
      "The CPU limit is not below the request",
    );
    expect(clusterFormErrors(READY, filled({ requestsMemory: "2Gi", limitsMemory: "1Gi" })).limitsMemory).toMatch(
      /not below/,
    );
    expect(
      clusterFormErrors(
        READY,
        filled({ requestsMemory: "128Mi", parameters: [{ key: "shared_buffers", value: "256MB" }] }),
      ).requestsMemory,
    ).toBe("The memory request is not below shared_buffers");
    expect(
      clusterFormErrors(
        READY,
        filled({ requestsMemory: "1Gi", parameters: [{ key: "shared_buffers", value: "256MB" }] }),
      ).requestsMemory,
    ).toBeUndefined();
    expect(clusterFormErrors(READY, filled({ requestsCpu: "many" })).requestsCpu).toMatch(/such as 500m/);
  });

  it("check the parameters, the recovery and the scheduling rows", () => {
    const parameters = clusterFormErrors(
      READY,
      filled({
        parameters: [
          { key: "port", value: "5433" },
          { key: "wal_level", value: "minimal" },
          { key: "maintenance_work_mem", value: "" },
          { key: "work_mem", value: "8MB" },
          { key: "work_mem", value: "16MB" },
        ],
      }),
    );
    expect(parameters["parameters.0.key"]).toMatch(/fixed by the operator/);
    expect(parameters["parameters.1.value"]).toMatch(/more than one instance/);
    expect(parameters["parameters.2.value"]).toBe("A parameter needs a value");
    expect(parameters["parameters.3.key"]).toBe("work_mem is set twice");
    expect(parameters["parameters.4.key"]).toBe("work_mem is set twice");
    expect(parameters.parameters).toBe("A parameter is wrong");

    expect(clusterFormErrors(READY, filled({ bootstrap: "recovery" })).recoveryBackup).toBe(
      "Pick the backup to recover from",
    );
    expect(
      clusterFormErrors(READY, filled({ bootstrap: "recovery", recoveryBackup: "pg-old-pending" })).recoveryBackup,
    ).toMatch(/only a completed backup/);
    expect(
      clusterFormErrors(
        READY,
        filled({ bootstrap: "recovery", recoveryBackup: "pg-old-20260920174036", recoveryTargetTime: "yesterday" }),
      ).recoveryTargetTime,
    ).toMatch(/RFC 3339/);
    const store = clusterFormErrors(READY, filled({ bootstrap: "recovery", recoverySource: "objectStore" }));
    expect(store.recoveryObjectStore).toBe("Pick the object store that holds the backups");
    expect(store.recoveryServerName).toBe("A name is required");
    expect(
      clusterFormErrors(
        READY,
        filled({
          bootstrap: "recovery",
          recoverySource: "objectStore",
          recoveryObjectStore: "minio-store",
          recoveryServerName: "pg",
        }),
      ).recoveryServerName,
    ).toMatch(/archive into the folder it recovers from/);
    expect(
      clusterFormErrors(
        READY,
        filled({
          bootstrap: "recovery",
          recoverySource: "objectStore",
          recoveryObjectStore: "minio-store",
          recoveryServerName: "pg-old",
        }),
      ).recoveryServerName,
    ).toBeUndefined();

    expect(clusterFormErrors(READY, filled({ antiAffinity: "required", topologyKey: "a/b/c" })).topologyKey).toMatch(
      /one slash/,
    );
    const selector = clusterFormErrors(
      READY,
      filled({
        nodeSelector: [
          { key: "", value: "" },
          { key: "disk", value: "a b" },
        ],
      }),
    );
    expect(selector["nodeSelector.0.key"]).toBe("A key is required");
    expect(selector["nodeSelector.1.value"]).toMatch(/63 characters/);
    expect(selector.nodeSelector).toBe("A node selector is wrong");
  });

  it("put the first wrong field under OK, then the access review", () => {
    expect(clusterCreateBlockReason(READY, filled({ name: "", storageSize: "" }))).toBe("A name is required");
    expect(clusterCreateBlockReason(READY, filled(), "Your account may not create clusters in db")).toBe(
      "Your account may not create clusters in db",
    );
  });
});

describe("the warnings at the fields", () => {
  it("warn and never block on a collision or an unseen reference", () => {
    const warnings = clusterFormWarnings(
      READY,
      filled({
        name: "pg-old",
        objectStore: "elsewhere",
        storageClass: "slow",
        initdbSecret: "tls-thing",
        superuserSecret: "nope",
      }),
    );
    expect(warnings.name).toMatch(/already exists/);
    expect(warnings.objectStore).toMatch(/No object store named elsewhere/);
    expect(warnings.storageClass).toMatch(/No storage class named slow/);
    expect(warnings.initdbSecret).toMatch(/kubernetes.io\/tls secret/);
    expect(warnings.superuserSecret).toMatch(/No secret named nope/);
    expect(clusterCreateBlockReason(READY, filled({ name: "pg-old" }))).toBeUndefined();
  });

  it("say nothing while a read is still loading or was refused", () => {
    const loading = emptyClusterCreateInputs(["db"]);
    expect(clusterFormWarnings(loading, filled({ objectStore: "elsewhere" })).objectStore).toBeUndefined();
    const refused = { ...READY, reads: { ...READY.reads, secrets: "unavailable" as const } };
    expect(clusterFormWarnings(refused, filled({ initdbSecret: "nope" })).initdbSecret).toBeUndefined();
    expect(
      clusterFormWarnings(READY, filled({ imageSource: "catalog", catalog: "ImageCatalog/gone", catalogMajor: "17" }))
        .catalog,
    ).toMatch(/No catalog/);
  });
});

describe("the summary", () => {
  it("says what the operator will create, and what it costs", () => {
    const facts = clusterCreateFacts(READY, filled());
    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.writes).toEqual([
      {
        verb: "create",
        text: "create Cluster db/pg: 3 instances, image ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie, storage 10Gi, a new database app owned by app, WAL archiving to minio-store",
      },
    ]);
    expect(facts.notes[0]).toBe(
      "The operator creates the pods pg-1 to pg-3, each on a volume of 10Gi, the services pg-rw, pg-ro and pg-r, and the secrets pg-app.",
    );
    expect(facts.notes[1]).toMatch(/Bootstrap: a new database app owned by app/);
    expect(facts.notes[2]).toMatch(/WAL is archived to the object store minio-store/);
    expect(facts.warnings).toEqual([
      "No resource requests: the pods get the BestEffort class and are the first evicted under pressure.",
    ]);
  });

  it("warns on one instance, no store, supervised updates and all-synchronous standbys", () => {
    const warnings = clusterCreateWarnings(
      READY,
      filled({
        instances: "2",
        objectStore: "",
        updateStrategy: "supervised",
        syncEnabled: true,
        syncNumber: "1",
        requestsCpu: "1",
        limitsCpu: "2",
      }),
    );
    expect(warnings).toEqual([
      "No object store: no WAL archiving, so no backup and no point in time recovery for this cluster.",
      "Requests and limits differ: the pods miss the Guaranteed class the operator recommends for a database.",
      "Supervised updates: after every change the primary waits for a switchover by hand.",
      "Every standby is synchronous with required durability: one lost standby blocks every write.",
    ]);
    expect(clusterCreateWarnings(READY, filled({ instances: "1" }))[0]).toMatch(/One instance/);
    expect(
      clusterCreateWarnings(READY, filled({ syncEnabled: true, syncNumber: "2", syncDurability: "preferred" })),
    ).not.toContain("Every standby is synchronous with required durability: one lost standby blocks every write.");
  });

  it("describes the recovery and the catalog image", () => {
    const notes = clusterCreateNotes(
      READY,
      filled({
        bootstrap: "recovery",
        recoverySource: "objectStore",
        recoveryObjectStore: "minio-store",
        recoveryServerName: "pg-old",
      }),
    );
    expect(notes[1]).toMatch(/recovery of pg-old from the object store minio-store/);
    const facts = clusterCreateFacts(
      READY,
      filled({
        imageSource: "catalog",
        catalog: catalogKey({ kind: "ImageCatalog", name: "postgres" }),
        catalogMajor: "17",
      }),
    );
    expect(facts.writes[0].text).toMatch(/PostgreSQL 17 from the catalog postgres/);
    expect(facts.warnings).toContain(
      "No resource requests: the pods get the BestEffort class and are the first evicted under pressure.",
    );
  });
});

describe("tablespaces (SPEC-0029)", () => {
  it("checks a tablespace name as the operator does", () => {
    expect(tablespaceNameError("")).toBe("A tablespace name is required");
    expect(tablespaceNameError("pg_fast")).toContain("reserved for PostgreSQL");
    expect(tablespaceNameError("1data")).toContain("PostgreSQL identifier");
    expect(tablespaceNameError("da-ta")).toContain("PostgreSQL identifier");
    expect(tablespaceNameError("a".repeat(64))).toBe("A tablespace name is 63 characters at most");
    expect(tablespaceNameError("Ok_1$")).toBeUndefined();
  });

  it("derives the volume name the operator derives", () => {
    expect(tablespaceVolumeName("analytics")).toBe("tbs-analytics");
    expect(tablespaceVolumeName("_Big$Data")).toBe("tbs-1big-data");
  });

  it("refuses duplicate names ignoring case, names that become one volume, a missing size and a bad owner", () => {
    const errors = clusterFormErrors(
      READY,
      filled({
        tablespaces: [
          { name: "Data", size: "1Gi", storageClass: "", owner: "", temporary: false },
          { name: "data", size: "1Gi", storageClass: "", owner: "", temporary: false },
          { name: "a_b", size: "", storageClass: "", owner: "bad owner", temporary: false },
          { name: "a$b", size: "1Gi", storageClass: "", owner: "", temporary: false },
        ],
      }),
    );
    expect(errors["tablespaces.1.name"]).toBe("data is declared twice (tablespace names are compared ignoring case)");
    expect(errors["tablespaces.2.size"]).toBe("A size is required");
    expect(errors["tablespaces.2.owner"]).toBeDefined();
    expect(errors["tablespaces.3.name"]).toBe("a$b and a_b become the same volume name (tbs-a-b)");
    expect(errors.tablespaces).toBe("A tablespace is wrong");
    expect(clusterFormErrors(READY, filled({ tablespaces: [emptyTablespaceRow()] }))["tablespaces.0.name"]).toBe(
      "A tablespace name is required",
    );
    expect(clusterCreateBlockReason(READY, filled({ tablespaces: [emptyTablespaceRow()] }))).toBe(
      "A tablespace is wrong",
    );
  });

  it("sends the rows as spec.tablespaces, with only what was decided", () => {
    const form = filled({
      tablespaces: [
        { name: "reports", size: "2Gi", storageClass: "fast", owner: "reporter", temporary: false },
        { name: "scratch", size: "1Gi", storageClass: "", owner: "", temporary: true },
      ],
    });
    expect(clusterFormErrors(READY, form)).toEqual({});
    const spec = clusterCreateBody(form).spec as Record<string, unknown>;
    expect(spec.tablespaces).toEqual([
      { name: "reports", storage: { size: "2Gi", storageClass: "fast" }, owner: { name: "reporter" } },
      { name: "scratch", storage: { size: "1Gi" }, temporary: true },
    ]);
    expect((clusterCreateBody(filled()).spec as Record<string, unknown>).tablespaces).toBeUndefined();
    expect(clusterCreateNotes(READY, form).some((note) => note.startsWith("2 tablespaces (reports, scratch)"))).toBe(
      true,
    );
    expect(clusterCreateFacts(READY, form).writes[0].text).toContain("2 tablespaces");
    expect(
      clusterFormWarnings(READY, filled({ tablespaces: [{ ...emptyTablespaceRow(), storageClass: "nope" }] }))[
        "tablespaces.0.storageClass"
      ],
    ).toContain("No storage class named nope");
  });
});

describe("volume snapshot backups (SPEC-0029)", () => {
  it("sends only what differs from the operator's defaults", () => {
    const enabled = filled({ snapshotsEnabled: true });
    expect((clusterCreateBody(enabled).spec as Record<string, unknown>).backup).toEqual({ volumeSnapshot: {} });
    const cold = filled({ snapshotsEnabled: true, snapshotClass: "csi-hostpath-snapclass", snapshotMode: "cold" });
    expect((clusterCreateBody(cold).spec as Record<string, unknown>).backup).toEqual({
      volumeSnapshot: { className: "csi-hostpath-snapclass", online: false },
    });
    const hot = filled({
      snapshotsEnabled: true,
      snapshotWaitForArchive: false,
      snapshotImmediateCheckpoint: true,
      snapshotOwner: "backup",
      backupTarget: "primary",
      walEnabled: true,
      walSize: "1Gi",
      snapshotWalClass: "wal-class",
    });
    expect((clusterCreateBody(hot).spec as Record<string, unknown>).backup).toEqual({
      target: "primary",
      volumeSnapshot: {
        walClassName: "wal-class",
        onlineConfiguration: { waitForArchive: false, immediateCheckpoint: true },
        snapshotOwnerReference: "backup",
      },
    });
    // The WAL class goes only with a WAL volume; nothing is sent while the box is unchecked.
    expect(
      (
        clusterCreateBody(filled({ snapshotsEnabled: true, snapshotWalClass: "wal-class" })).spec as Record<
          string,
          unknown
        >
      ).backup,
    ).toEqual({ volumeSnapshot: {} });
    expect((clusterCreateBody(filled({ snapshotClass: "x" })).spec as Record<string, unknown>).backup).toBeUndefined();
  });

  it("refuses the method without the CRD, and says what hot and cold cost", () => {
    expect(
      clusterFormErrors({ ...READY, volumeSnapshotCrd: false }, filled({ snapshotsEnabled: true })).snapshotsEnabled,
    ).toContain("VolumeSnapshot CRD is not installed");
    expect(clusterFormErrors(READY, filled({ snapshotsEnabled: true }))).toEqual({});
    expect(
      clusterFormWarnings(READY, filled({ snapshotsEnabled: true, snapshotClass: "nope" })).snapshotClass,
    ).toContain("No snapshot class named nope");
    const hot = clusterCreateWarnings(READY, filled({ snapshotsEnabled: true, objectStore: "" }));
    expect(hot.some((warning) => warning.startsWith("Hot snapshots without WAL archiving"))).toBe(true);
    const cold = clusterCreateWarnings(READY, filled({ snapshotsEnabled: true, snapshotMode: "cold", instances: "1" }));
    expect(cold.some((warning) => warning.startsWith("Cold snapshots fence the only instance"))).toBe(true);
    expect(
      clusterCreateWarnings(READY, filled({ snapshotsEnabled: true, snapshotMode: "cold", instances: "3" })).some(
        (warning) => warning.startsWith("Cold snapshots fence"),
      ),
    ).toBe(false);
    expect(
      clusterCreateNotes(READY, filled({ snapshotsEnabled: true, snapshotClass: "csi-hostpath-snapclass" })).some(
        (note) => note.startsWith("Backups by volume snapshot are available (class csi-hostpath-snapclass, hot)"),
      ),
    ).toBe(true);
  });
});

describe("recovery from volume snapshots (SPEC-0029)", () => {
  const snapshots = (overrides: Partial<ClusterForm> = {}) =>
    filled({ bootstrap: "recovery", recoverySource: "volumeSnapshots", recoveryDataSnapshot: "snap-ok", ...overrides });

  it("requires a ready data snapshot, a WAL volume for a WAL snapshot, and the archive for a point in time", () => {
    expect(clusterCreateBlockReason(READY, snapshots({ recoveryDataSnapshot: "" }))).toBe(
      "Pick the data snapshot to recover from",
    );
    expect(clusterFormErrors(READY, snapshots({ recoveryDataSnapshot: "snap-pending" })).recoveryDataSnapshot).toBe(
      "snap-pending is not ready to use yet: the recovery would wait on it",
    );
    expect(clusterFormErrors(READY, snapshots({ recoveryWalSnapshot: "snap-ok-wal" })).recoveryWalSnapshot).toContain(
      "needs a WAL volume of its own",
    );
    expect(
      clusterFormErrors(READY, snapshots({ walEnabled: true, walSize: "1Gi", recoveryWalSnapshot: "snap-ok-wal" })),
    ).toEqual({});
    expect(
      clusterFormErrors(READY, snapshots({ recoveryTargetTime: "2026-09-24T10:00:00Z" })).recoveryTargetTime,
    ).toContain("give the WAL archive of the source");
    const withArchive = snapshots({
      recoveryTargetTime: "2026-09-24T10:00:00Z",
      recoveryWalArchive: true,
      recoveryObjectStore: "minio-store",
      recoveryServerName: "pg-old",
    });
    expect(clusterFormErrors(READY, withArchive)).toEqual({});
    expect(clusterFormErrors(READY, snapshots({ recoveryWalArchive: true })).recoveryObjectStore).toBe(
      "Pick the object store that holds the backups",
    );
  });

  it("sends the snapshot references, the tablespace map and the WAL archive of the source", () => {
    const form = snapshots({
      walEnabled: true,
      walSize: "1Gi",
      recoveryWalSnapshot: "snap-ok-wal",
      tablespaces: [{ name: "analytics", size: "512Mi", storageClass: "", owner: "", temporary: false }],
      recoveryTablespaceSnapshots: { analytics: "snap-ok-tbs-analytics" },
      recoveryWalArchive: true,
      recoveryObjectStore: "minio-store",
      recoveryServerName: "pg-old",
    });
    const spec = clusterCreateBody(form).spec as Record<string, unknown>;
    const ref = (name: string) => ({ name, kind: "VolumeSnapshot", apiGroup: "snapshot.storage.k8s.io" });
    expect(spec.bootstrap).toEqual({
      recovery: {
        source: "pg-old",
        volumeSnapshots: {
          storage: ref("snap-ok"),
          walStorage: ref("snap-ok-wal"),
          tablespaceStorage: { analytics: ref("snap-ok-tbs-analytics") },
        },
      },
    });
    expect(spec.externalClusters).toEqual([
      {
        name: "pg-old",
        plugin: {
          name: "barman-cloud.cloudnative-pg.io",
          parameters: { barmanObjectName: "minio-store", serverName: "pg-old" },
        },
      },
    ]);
    const bare = clusterCreateBody(snapshots()).spec as Record<string, unknown>;
    expect(bare.bootstrap).toEqual({ recovery: { volumeSnapshots: { storage: ref("snap-ok") } } });
    expect(bare.externalClusters).toBeUndefined();
    expect(clusterCreateFacts(READY, snapshots()).writes[0].text).toContain(
      "recovery from the volume snapshot snap-ok (cold, backup snap-ok of pg-old)",
    );
  });

  it("warns on a hot snapshot without the archive, on the wrong kind of snapshot, and on the replicas", () => {
    expect(clusterFormWarnings(READY, snapshots({ recoveryDataSnapshot: "snap-hot" })).recoveryDataSnapshot).toContain(
      "snap-hot is a hot snapshot",
    );
    expect(
      clusterCreateWarnings(READY, snapshots({ recoveryDataSnapshot: "snap-hot" })).some((warning) =>
        warning.startsWith("The data snapshot was hot"),
      ),
    ).toBe(true);
    expect(clusterFormWarnings(READY, snapshots({ recoveryDataSnapshot: "snap-ok-wal" })).recoveryDataSnapshot).toBe(
      "snap-ok-wal is a PG_WAL snapshot, not PG_DATA",
    );
    expect(
      clusterFormWarnings(READY, snapshots({ recoveryDataSnapshot: "someone-else" })).recoveryDataSnapshot,
    ).toContain("was not taken by the operator");
    expect(clusterFormWarnings(READY, snapshots({ recoveryDataSnapshot: "unknown" })).recoveryDataSnapshot).toContain(
      "No snapshot named unknown was found",
    );
    expect(
      clusterFormWarnings(
        READY,
        snapshots({
          tablespaces: [{ name: "other", size: "1Gi", storageClass: "", owner: "", temporary: false }],
          recoveryTablespaceSnapshots: { other: "snap-ok-tbs-analytics" },
        }),
      )["recoveryTablespaceSnapshots.other"],
    ).toContain("the snapshot of the tablespace analytics, not other");
    expect(
      clusterCreateWarnings(READY, snapshots({ instances: "3" })).some((warning) =>
        warning.startsWith("The replicas of a cluster recovered from a snapshot"),
      ),
    ).toBe(true);
    expect(
      clusterCreateWarnings(READY, snapshots({ instances: "1" })).some((warning) =>
        warning.startsWith("The replicas of a cluster recovered from a snapshot"),
      ),
    ).toBe(false);
  });
});
