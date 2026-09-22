/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  defaultObjectStoreForm,
  destinationPathError,
  endpointUrlError,
  objectStoreBlockReason,
  objectStoreBody,
  objectStoreErrors,
  objectStoreFacts,
  objectStoreSummaryWarnings,
  objectStoreWarnings,
  retentionPolicy,
} from "./object-store-create";

import type { ObjectStoreForm, ObjectStoreInputs } from "./object-store-create";

const READY: ObjectStoreInputs = {
  stores: ["minio-store"],
  secrets: [
    { name: "creds", keys: ["ACCESS_KEY_ID", "ACCESS_SECRET_KEY"] },
    { name: "ca", keys: ["ca.crt"] },
  ],
  reads: { stores: "ready", secrets: "ready" },
};

function filled(overrides: Partial<ObjectStoreForm> = {}): ObjectStoreForm {
  return {
    ...defaultObjectStoreForm("db"),
    name: "backups",
    destinationPath: "s3://backups/pg/",
    endpointURL: "https://minio.db.svc:9000",
    s3AccessKeyId: { name: "creds", key: "ACCESS_KEY_ID" },
    s3SecretAccessKey: { name: "creds", key: "ACCESS_SECRET_KEY" },
    ...overrides,
  };
}

describe("the destination and the endpoint", () => {
  it("want the scheme of the provider and a bucket", () => {
    expect(destinationPathError("s3", "s3://bucket/path/")).toBeUndefined();
    expect(destinationPathError("s3", "gs://bucket/")).toMatch(/starts with s3:\/\//);
    expect(destinationPathError("azure", "https://acct.blob.core.windows.net/c/")).toBeUndefined();
    expect(destinationPathError("azure", "azure://c/")).toBeUndefined();
    expect(destinationPathError("google", "gs://bucket/folder")).toBeUndefined();
    expect(destinationPathError("google", "s3://bucket/")).toMatch(/starts with gs:\/\//);
    expect(destinationPathError("s3", "s3://")).toBe("A destination path names a bucket");
    expect(destinationPathError("s3", "")).toBe("A destination path is required");
    expect(destinationPathError("s3", "s3://a b/")).toBe("A destination path has no blanks");
    expect(endpointUrlError("")).toBeUndefined();
    expect(endpointUrlError("https://minio:9000")).toBeUndefined();
    expect(endpointUrlError("minio:9000")).toMatch(/is a URL/);
  });
});

describe("the credentials", () => {
  it("want exactly what the picked authentication needs", () => {
    expect(objectStoreBlockReason(READY, filled())).toBeUndefined();
    expect(objectStoreErrors(READY, filled({ s3AccessKeyId: { name: "", key: "" } })).s3AccessKeyId).toBe(
      "The access key id needs a secret",
    );
    expect(
      objectStoreErrors(READY, filled({ s3SecretAccessKey: { name: "creds", key: "" } })).s3SecretAccessKey,
    ).toMatch(/needs the key/);
    expect(objectStoreErrors(READY, filled({ s3Auth: "iam", s3AccessKeyId: { name: "", key: "" } }))).toEqual({});
    const azure = filled({
      provider: "azure",
      destinationPath: "https://acct.blob.core.windows.net/c/",
      azureAuth: "storageKey",
    });
    expect(objectStoreErrors(READY, azure).azureStorageAccount).toBe("The storage account needs a secret");
    expect(
      objectStoreErrors(READY, {
        ...azure,
        azureStorageAccount: { name: "az", key: "AZURE_STORAGE_ACCOUNT" },
        azureStorageKey: { name: "az", key: "AZURE_STORAGE_KEY" },
      }),
    ).toEqual({});
    const google = filled({ provider: "google", destinationPath: "gs://bucket/" });
    expect(objectStoreErrors(READY, google).googleCredentials).toBe("The application credentials needs a secret");
    expect(objectStoreErrors(READY, { ...google, googleAuth: "gke" })).toEqual({});
    expect(objectStoreErrors(READY, filled({ endpointCA: { name: "ca", key: "" } })).endpointCA).toMatch(
      /needs the key/,
    );
  });

  it("check the numbers and the tags", () => {
    expect(objectStoreErrors(READY, filled({ walMaxParallel: "0" })).walMaxParallel).toBe("Max parallel is 1 or more");
    expect(objectStoreErrors(READY, filled({ dataJobs: "x" })).dataJobs).toBe("Jobs is a whole number");
    expect(objectStoreErrors(READY, filled({ retentionAmount: "0" })).retentionAmount).toBe(
      "The retention is 1 or more",
    );
    expect(objectStoreErrors(READY, filled({ retentionIntervalSeconds: "-1" })).retentionIntervalSeconds).toBe(
      "The interval is a whole number",
    );
    const tags = objectStoreErrors(
      READY,
      filled({
        tags: [
          { key: "", value: "" },
          { key: "env", value: "a" },
          { key: "env", value: "b" },
        ],
      }),
    );
    expect(tags["tags.0.key"]).toBe("A key is required");
    expect(tags["tags.2.key"]).toBe("env is set twice");
    expect(tags.tags).toBe("A tag is wrong");
  });

  it("warn on a collision, an unseen secret and a key the secret lacks", () => {
    expect(objectStoreWarnings(READY, filled({ name: "minio-store" })).name).toMatch(/already exists/);
    expect(objectStoreWarnings(READY, filled({ s3AccessKeyId: { name: "nope", key: "k" } })).s3AccessKeyId).toMatch(
      /No secret named nope/,
    );
    expect(objectStoreWarnings(READY, filled({ s3AccessKeyId: { name: "creds", key: "KEY" } })).s3AccessKeyId).toMatch(
      /has no key KEY/,
    );
    expect(objectStoreWarnings(READY, filled({ endpointCA: { name: "ca", key: "ca.crt" } }))).toEqual({});
    expect(
      objectStoreWarnings(
        { ...READY, reads: { ...READY.reads, secrets: "loading" } },
        filled({ s3AccessKeyId: { name: "nope", key: "k" } }),
      ),
    ).toEqual({});
  });
});

describe("the body and the facts", () => {
  it("sends the S3 store with keys, compression and retention", () => {
    expect(objectStoreBody(filled())).toEqual({
      apiVersion: "barmancloud.cnpg.io/v1",
      kind: "ObjectStore",
      metadata: { name: "backups", namespace: "db" },
      spec: {
        configuration: {
          destinationPath: "s3://backups/pg/",
          endpointURL: "https://minio.db.svc:9000",
          s3Credentials: {
            accessKeyId: { name: "creds", key: "ACCESS_KEY_ID" },
            secretAccessKey: { name: "creds", key: "ACCESS_SECRET_KEY" },
          },
          wal: { compression: "gzip" },
          data: { compression: "gzip" },
        },
        retentionPolicy: "30d",
      },
    });
    expect(retentionPolicy(filled({ retentionAmount: "4", retentionUnit: "w" }))).toBe("4w");
    expect(retentionPolicy(filled({ retentionAmount: "" }))).toBeUndefined();
  });

  it("sends each authentication as the plugin reads it, and the rest when set", () => {
    const iam = objectStoreBody(filled({ s3Auth: "iam" })) as { spec: { configuration: Record<string, unknown> } };
    expect(iam.spec.configuration.s3Credentials).toEqual({ inheritFromIAMRole: true });
    const azure = objectStoreBody(
      filled({
        provider: "azure",
        azureAuth: "sasToken",
        azureStorageAccount: { name: "az", key: "ACCOUNT" },
        azureSasToken: { name: "az", key: "SAS" },
        endpointCA: { name: "ca", key: "ca.crt" },
        walCompression: "zstd",
        walEncryption: "AES256",
        walMaxParallel: "4",
        dataCompression: "",
        dataEncryption: "aws:kms",
        dataJobs: "2",
        dataImmediateCheckpoint: true,
        retentionAmount: "2",
        retentionUnit: "m",
        retentionIntervalSeconds: "600",
        tags: [{ key: "env", value: "prod" }],
        historyTags: [{ key: "team", value: "db" }],
      }),
    ) as { spec: Record<string, unknown> };
    expect(azure.spec).toEqual({
      configuration: {
        destinationPath: "s3://backups/pg/",
        endpointURL: "https://minio.db.svc:9000",
        endpointCA: { name: "ca", key: "ca.crt" },
        azureCredentials: {
          storageAccount: { name: "az", key: "ACCOUNT" },
          storageSasToken: { name: "az", key: "SAS" },
        },
        wal: { compression: "zstd", encryption: "AES256", maxParallel: 4 },
        data: { encryption: "aws:kms", jobs: 2, immediateCheckpoint: true },
        tags: { env: "prod" },
        historyTags: { team: "db" },
      },
      retentionPolicy: "2m",
      instanceSidecarConfiguration: { retentionPolicyIntervalSeconds: 600 },
    });
    const google = objectStoreBody(filled({ provider: "google", googleAuth: "gke" })) as {
      spec: { configuration: Record<string, unknown> };
    };
    expect(google.spec.configuration.googleCredentials).toEqual({ gkeEnvironment: true });
    const ad = objectStoreBody(
      filled({ provider: "azure", azureAuth: "azureAd", azureStorageAccount: { name: "az", key: "A" } }),
    ) as {
      spec: { configuration: Record<string, unknown> };
    };
    expect(ad.spec.configuration.azureCredentials).toEqual({
      storageAccount: { name: "az", key: "A" },
      inheritFromAzureAD: true,
    });
  });

  it("says what the store is for and what it costs", () => {
    const facts = objectStoreFacts(READY, filled());
    expect(facts.subject).toBe("ObjectStore db/backups");
    expect(facts.writes[0].text).toBe("create ObjectStore db/backups: S3 at s3://backups/pg/, kept 30 days");
    expect(facts.notes[1]).toBe("Authentication: S3 keys from a secret.");
    expect(facts.notes[2]).toBe("WAL compressed with gzip; base backups compressed with gzip.");
    expect(facts.notes[3]).toBe(
      "Backups are kept 30 days, enforced by the sidecar of each primary every 1800 seconds.",
    );
    expect(facts.warnings).toEqual([]);
    expect(
      objectStoreSummaryWarnings(
        READY,
        filled({ retentionAmount: "", endpointURL: "http://minio:9000", s3Auth: "iam" }),
      ),
    ).toEqual([
      "No retention policy: every backup and every WAL file is kept until somebody deletes it.",
      "A plaintext endpoint: WAL and backups travel unencrypted to the store.",
      "Credentials from the environment: the nodes or the pods must carry the role, or every archive fails.",
    ]);
  });
});
