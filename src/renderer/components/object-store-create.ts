/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create ObjectStore form (SPEC-0026): the destination
// and the credentials of each provider with the exclusivity rules the
// plugin's library checks and its API does not, the WAL and data settings,
// the retention policy, what the store will be used for, and the exact body
// of the one `create`. Pure.

import { BARMAN_CLOUD_API_VERSION } from "../api/barmancloud/object-store-v1";
import {
  collisionWarning,
  createLine,
  duplicateKeys,
  firstError,
  integerError,
  keyValueObject,
  labelKeyError,
  objectNameError,
} from "./create-forms";
import { subjectOf } from "./write-actions";

import type { KeyValue } from "./create-forms";
import type { ActionDialogFacts } from "./write-actions";

export type ReadState = "loading" | "ready" | "unavailable";

export interface SecretKeysChoice {
  name: string;
  /** The keys of the secret, when the read could see them. */
  keys: string[];
}

export interface ObjectStoreInputs {
  stores: string[];
  secrets: SecretKeysChoice[];
  reads: Record<"stores" | "secrets", ReadState>;
}

export function emptyObjectStoreInputs(): ObjectStoreInputs {
  return { stores: [], secrets: [], reads: { stores: "loading", secrets: "loading" } };
}

export type StoreProvider = "s3" | "azure" | "google";
export type S3Auth = "keys" | "iam";
export type AzureAuth = "connectionString" | "storageKey" | "sasToken" | "azureAd" | "defaultCredentials";
export type GoogleAuth = "credentials" | "gke";
export type WalCompression = "" | "bzip2" | "gzip" | "lz4" | "snappy" | "xz" | "zstd";
export type DataCompression = "" | "bzip2" | "gzip" | "lz4" | "snappy";
export type Encryption = "" | "AES256" | "aws:kms";
export type RetentionUnit = "d" | "w" | "m";

/** A `{name, key}` selector of a secret, as typed. */
export interface SecretKeyRef {
  name: string;
  key: string;
}

export interface ObjectStoreForm {
  namespace: string;
  name: string;
  provider: StoreProvider;
  destinationPath: string;
  endpointURL: string;
  endpointCA: SecretKeyRef;
  s3Auth: S3Auth;
  s3AccessKeyId: SecretKeyRef;
  s3SecretAccessKey: SecretKeyRef;
  azureAuth: AzureAuth;
  azureConnectionString: SecretKeyRef;
  azureStorageAccount: SecretKeyRef;
  azureStorageKey: SecretKeyRef;
  azureSasToken: SecretKeyRef;
  googleAuth: GoogleAuth;
  googleCredentials: SecretKeyRef;
  walCompression: WalCompression;
  walEncryption: Encryption;
  walMaxParallel: string;
  dataCompression: DataCompression;
  dataEncryption: Encryption;
  dataJobs: string;
  dataImmediateCheckpoint: boolean;
  retentionAmount: string;
  retentionUnit: RetentionUnit;
  retentionIntervalSeconds: string;
  tags: KeyValue[];
  historyTags: KeyValue[];
}

const NO_REF: SecretKeyRef = { name: "", key: "" };

export function defaultObjectStoreForm(namespace: string): ObjectStoreForm {
  return {
    namespace,
    name: "",
    provider: "s3",
    destinationPath: "",
    endpointURL: "",
    endpointCA: { ...NO_REF },
    s3Auth: "keys",
    s3AccessKeyId: { name: "", key: "ACCESS_KEY_ID" },
    s3SecretAccessKey: { name: "", key: "ACCESS_SECRET_KEY" },
    azureAuth: "connectionString",
    azureConnectionString: { name: "", key: "AZURE_STORAGE_CONNECTION_STRING" },
    azureStorageAccount: { name: "", key: "AZURE_STORAGE_ACCOUNT" },
    azureStorageKey: { name: "", key: "AZURE_STORAGE_KEY" },
    azureSasToken: { name: "", key: "AZURE_STORAGE_SAS_TOKEN" },
    googleAuth: "credentials",
    googleCredentials: { name: "", key: "gcsCredentials" },
    walCompression: "gzip",
    walEncryption: "",
    walMaxParallel: "",
    dataCompression: "gzip",
    dataEncryption: "",
    dataJobs: "",
    dataImmediateCheckpoint: false,
    retentionAmount: "30",
    retentionUnit: "d",
    retentionIntervalSeconds: "",
    tags: [],
    historyTags: [],
  };
}

export const WAL_COMPRESSIONS: readonly WalCompression[] = ["", "bzip2", "gzip", "lz4", "snappy", "xz", "zstd"];
export const DATA_COMPRESSIONS: readonly DataCompression[] = ["", "bzip2", "gzip", "lz4", "snappy"];
export const ENCRYPTIONS: readonly Encryption[] = ["", "AES256", "aws:kms"];

const PATH_SCHEMES: Record<StoreProvider, { schemes: string[]; example: string }> = {
  s3: { schemes: ["s3://"], example: "s3://bucket/path/" },
  azure: { schemes: ["azure://", "https://"], example: "https://account.blob.core.windows.net/container/folder/" },
  google: { schemes: ["gs://"], example: "gs://bucket/folder/" },
};

export function destinationPathError(provider: StoreProvider, path: string): string | undefined {
  const text = path.trim();
  if (text === "") return "A destination path is required";
  if (/\s/.test(text)) return "A destination path has no blanks";
  const { schemes, example } = PATH_SCHEMES[provider];
  if (!schemes.some((scheme) => text.startsWith(scheme))) {
    return `A ${provider === "s3" ? "S3" : provider === "azure" ? "Azure" : "Google Cloud"} path starts with ${schemes.join(" or ")}, as in ${example}`;
  }
  if (text.length <= schemes.find((scheme) => text.startsWith(scheme))!.length)
    return "A destination path names a bucket";
  return undefined;
}

export function endpointUrlError(url: string): string | undefined {
  const text = url.trim();
  if (text === "") return undefined;
  if (!/^https?:\/\/[^\s/]+/.test(text)) return "An endpoint is a URL such as https://minio.example.svc:9000";
  return undefined;
}

function refError(ref: SecretKeyRef, what: string): string | undefined {
  if (ref.name.trim() === "") return `${what} needs a secret`;
  if (ref.key.trim() === "") return `${what} needs the key of the secret that holds it`;
  return undefined;
}

/** The secret references the picked provider and authentication need, in reading order. */
export function requiredRefs(form: ObjectStoreForm): Array<{ field: string; ref: SecretKeyRef; what: string }> {
  if (form.provider === "s3") {
    return form.s3Auth === "keys"
      ? [
          { field: "s3AccessKeyId", ref: form.s3AccessKeyId, what: "The access key id" },
          { field: "s3SecretAccessKey", ref: form.s3SecretAccessKey, what: "The secret access key" },
        ]
      : [];
  }
  if (form.provider === "azure") {
    switch (form.azureAuth) {
      case "connectionString":
        return [{ field: "azureConnectionString", ref: form.azureConnectionString, what: "The connection string" }];
      case "storageKey":
        return [
          { field: "azureStorageAccount", ref: form.azureStorageAccount, what: "The storage account" },
          { field: "azureStorageKey", ref: form.azureStorageKey, what: "The storage key" },
        ];
      case "sasToken":
        return [
          { field: "azureStorageAccount", ref: form.azureStorageAccount, what: "The storage account" },
          { field: "azureSasToken", ref: form.azureSasToken, what: "The SAS token" },
        ];
      default:
        return [{ field: "azureStorageAccount", ref: form.azureStorageAccount, what: "The storage account" }];
    }
  }
  return form.googleAuth === "credentials"
    ? [{ field: "googleCredentials", ref: form.googleCredentials, what: "The application credentials" }]
    : [];
}

export const OBJECT_STORE_FIELD_ORDER: readonly string[] = [
  "namespace",
  "name",
  "destinationPath",
  "endpointURL",
  "s3AccessKeyId",
  "s3SecretAccessKey",
  "azureConnectionString",
  "azureStorageAccount",
  "azureStorageKey",
  "azureSasToken",
  "googleCredentials",
  "endpointCA",
  "walMaxParallel",
  "dataJobs",
  "retentionAmount",
  "retentionIntervalSeconds",
  "tags",
  "historyTags",
];

export function objectStoreErrors(_inputs: ObjectStoreInputs, form: ObjectStoreForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };
  if (form.namespace === "") errors.namespace = "A namespace is required";
  put("name", objectNameError(form.name));
  put("destinationPath", destinationPathError(form.provider, form.destinationPath));
  put("endpointURL", endpointUrlError(form.endpointURL));
  for (const { field, ref, what } of requiredRefs(form)) put(field, refError(ref, what));
  if (form.endpointCA.name.trim() !== "" || form.endpointCA.key.trim() !== "")
    put("endpointCA", refError(form.endpointCA, "The endpoint CA"));
  if (form.walMaxParallel.trim() !== "") put("walMaxParallel", integerError(form.walMaxParallel, "Max parallel", 1));
  if (form.dataJobs.trim() !== "") put("dataJobs", integerError(form.dataJobs, "Jobs", 1));
  if (form.retentionAmount.trim() !== "")
    put("retentionAmount", integerError(form.retentionAmount, "The retention", 1));
  if (form.retentionIntervalSeconds.trim() !== "")
    put("retentionIntervalSeconds", integerError(form.retentionIntervalSeconds, "The interval", 1));
  for (const [field, rows] of [
    ["tags", form.tags],
    ["historyTags", form.historyTags],
  ] as const) {
    const duplicates = duplicateKeys(rows);
    rows.forEach((row, index) => {
      const key = row.key.trim();
      const keyError = labelKeyError(key) ?? (duplicates.has(key) ? `${key} is set twice` : undefined);
      if (keyError) errors[`${field}.${index}.key`] = keyError;
    });
    if (Object.keys(errors).some((key) => key.startsWith(`${field}.`))) errors[field] = "A tag is wrong";
  }
  return errors;
}

export function objectStoreWarnings(inputs: ObjectStoreInputs, form: ObjectStoreForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning("object store", form.name, inputs.stores);
  if (collision) warnings.name = collision;
  if (inputs.reads.secrets !== "ready") return warnings;
  const refs = [...requiredRefs(form), { field: "endpointCA", ref: form.endpointCA, what: "The endpoint CA" }];
  for (const { field, ref } of refs) {
    if (ref.name.trim() === "") continue;
    const secret = inputs.secrets.find((candidate) => candidate.name === ref.name.trim());
    if (!secret) warnings[field] = `No secret named ${ref.name.trim()} was found: the store fails until it exists`;
    else if (ref.key.trim() !== "" && secret.keys.length > 0 && !secret.keys.includes(ref.key.trim())) {
      warnings[field] = `${secret.name} has no key ${ref.key.trim()} (it has ${secret.keys.join(", ")})`;
    }
  }
  return warnings;
}

function ref(value: SecretKeyRef): { name: string; key: string } {
  return { name: value.name.trim(), key: value.key.trim() };
}

export function retentionPolicy(form: ObjectStoreForm): string | undefined {
  const amount = form.retentionAmount.trim();
  return amount === "" ? undefined : `${amount}${form.retentionUnit}`;
}

export function objectStoreBody(form: ObjectStoreForm): Record<string, unknown> {
  const configuration: Record<string, unknown> = { destinationPath: form.destinationPath.trim() };
  if (form.endpointURL.trim() !== "") configuration.endpointURL = form.endpointURL.trim();
  if (form.endpointCA.name.trim() !== "") configuration.endpointCA = ref(form.endpointCA);
  if (form.provider === "s3") {
    configuration.s3Credentials =
      form.s3Auth === "keys"
        ? { accessKeyId: ref(form.s3AccessKeyId), secretAccessKey: ref(form.s3SecretAccessKey) }
        : { inheritFromIAMRole: true };
  } else if (form.provider === "azure") {
    switch (form.azureAuth) {
      case "connectionString":
        configuration.azureCredentials = { connectionString: ref(form.azureConnectionString) };
        break;
      case "storageKey":
        configuration.azureCredentials = {
          storageAccount: ref(form.azureStorageAccount),
          storageKey: ref(form.azureStorageKey),
        };
        break;
      case "sasToken":
        configuration.azureCredentials = {
          storageAccount: ref(form.azureStorageAccount),
          storageSasToken: ref(form.azureSasToken),
        };
        break;
      case "azureAd":
        configuration.azureCredentials = { storageAccount: ref(form.azureStorageAccount), inheritFromAzureAD: true };
        break;
      default:
        configuration.azureCredentials = {
          storageAccount: ref(form.azureStorageAccount),
          useDefaultAzureCredentials: true,
        };
    }
  } else {
    configuration.googleCredentials =
      form.googleAuth === "credentials"
        ? { applicationCredentials: ref(form.googleCredentials) }
        : { gkeEnvironment: true };
  }
  const wal: Record<string, unknown> = {};
  if (form.walCompression) wal.compression = form.walCompression;
  if (form.walEncryption) wal.encryption = form.walEncryption;
  if (form.walMaxParallel.trim() !== "") wal.maxParallel = Number(form.walMaxParallel);
  if (Object.keys(wal).length > 0) configuration.wal = wal;
  const data: Record<string, unknown> = {};
  if (form.dataCompression) data.compression = form.dataCompression;
  if (form.dataEncryption) data.encryption = form.dataEncryption;
  if (form.dataJobs.trim() !== "") data.jobs = Number(form.dataJobs);
  if (form.dataImmediateCheckpoint) data.immediateCheckpoint = true;
  if (Object.keys(data).length > 0) configuration.data = data;
  const tags = keyValueObject(form.tags);
  if (tags) configuration.tags = tags;
  const historyTags = keyValueObject(form.historyTags);
  if (historyTags) configuration.historyTags = historyTags;
  const spec: Record<string, unknown> = { configuration };
  const retention = retentionPolicy(form);
  if (retention) spec.retentionPolicy = retention;
  if (form.retentionIntervalSeconds.trim() !== "") {
    spec.instanceSidecarConfiguration = { retentionPolicyIntervalSeconds: Number(form.retentionIntervalSeconds) };
  }
  return {
    apiVersion: BARMAN_CLOUD_API_VERSION,
    kind: "ObjectStore",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

const UNIT_WORDS: Record<RetentionUnit, string> = { d: "day", w: "week", m: "month" };

export function retentionWords(form: ObjectStoreForm): string {
  const amount = form.retentionAmount.trim();
  if (amount === "") return "kept forever: no retention policy";
  return `kept ${amount} ${UNIT_WORDS[form.retentionUnit]}${amount === "1" ? "" : "s"}`;
}

function authWords(form: ObjectStoreForm): string {
  if (form.provider === "s3") return form.s3Auth === "keys" ? "S3 keys from a secret" : "the IAM role of the nodes";
  if (form.provider === "azure") {
    return {
      connectionString: "an Azure connection string from a secret",
      storageKey: "an Azure storage key from a secret",
      sasToken: "an Azure SAS token from a secret",
      azureAd: "Azure AD workload identity",
      defaultCredentials: "the default Azure credentials of the environment",
    }[form.azureAuth];
  }
  return form.googleAuth === "credentials" ? "Google application credentials from a secret" : "the GKE environment";
}

export function objectStoreNotes(form: ObjectStoreForm): string[] {
  const notes = [
    "Clusters use the store by naming it in their Barman Cloud plugin entry (barmanObjectName); each archives under its own name unless its plugin parameter serverName says otherwise.",
    `Authentication: ${authWords(form)}.`,
    `WAL ${form.walCompression ? `compressed with ${form.walCompression}` : "not compressed"}${form.walEncryption ? `, encrypted with ${form.walEncryption}` : ""}; base backups ${form.dataCompression ? `compressed with ${form.dataCompression}` : "not compressed"}${form.dataEncryption ? `, encrypted with ${form.dataEncryption}` : ""}.`,
    `Backups are ${retentionWords(form)}${form.retentionAmount.trim() !== "" ? `, enforced by the sidecar of each primary every ${form.retentionIntervalSeconds.trim() || "1800"} seconds` : ""}.`,
    "The store is only tried when a cluster uses it: wrong credentials show up on the cluster's archiving condition, not here.",
  ];
  return notes;
}

export function objectStoreSummaryWarnings(inputs: ObjectStoreInputs, form: ObjectStoreForm): string[] {
  const warnings: string[] = [];
  if (form.retentionAmount.trim() === "")
    warnings.push("No retention policy: every backup and every WAL file is kept until somebody deletes it.");
  if (form.endpointURL.trim().startsWith("http://"))
    warnings.push("A plaintext endpoint: WAL and backups travel unencrypted to the store.");
  if (
    (form.provider === "s3" && form.s3Auth === "iam") ||
    (form.provider === "azure" &&
      form.azureAuth !== "connectionString" &&
      form.azureAuth !== "storageKey" &&
      form.azureAuth !== "sasToken") ||
    (form.provider === "google" && form.googleAuth === "gke")
  ) {
    warnings.push(
      "Credentials from the environment: the nodes or the pods must carry the role, or every archive fails.",
    );
  }
  void inputs;
  return warnings;
}

export function objectStoreFacts(inputs: ObjectStoreInputs, form: ObjectStoreForm): ActionDialogFacts {
  const parts = [
    `${form.provider === "s3" ? "S3" : form.provider === "azure" ? "Azure" : "Google Cloud"} at ${form.destinationPath.trim() || "?"}`,
    retentionWords(form),
  ];
  return {
    subject: subjectOf("ObjectStore", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [{ verb: "create", text: createLine("ObjectStore", form.namespace, form.name, parts.join(", ")) }],
    notes: objectStoreNotes(form),
    warnings: objectStoreSummaryWarnings(inputs, form),
  };
}

export function objectStoreBlockReason(
  inputs: ObjectStoreInputs,
  form: ObjectStoreForm,
  accessReason?: string,
): string | undefined {
  return firstError(OBJECT_STORE_FIELD_ORDER, objectStoreErrors(inputs, form)) ?? accessReason;
}

export function objectStoreSuccessMessage(namespace: string, name: string): string {
  return `Requested the object store ${namespace}/${name}: clusters can name it in their plugin entry now`;
}
