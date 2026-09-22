/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create Cluster form (SPEC-0025): what the form offers
// from what the reads on open found, which field is wrong and why, what the
// operator will make of the object, and the exact body the one `create`
// sends. Pure: `cluster-create-dialog.tsx` renders it. Every rule of the
// operator's admission the form can express is here, with the sentence of
// the field, so that a mistake is read before the submit and not in the
// answer of the API server.

import { BARMAN_CLOUD_PLUGIN_NAME } from "../api/barmancloud/object-store-v1";
import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import {
  CLUSTER_NAME_MAX,
  collisionWarning,
  createLine,
  dnsLabelError,
  duplicateKeys,
  firstError,
  identifierError,
  imageReferenceError,
  integerError,
  keyValueObject,
  labelKeyError,
  labelValueError,
  objectNameError,
  parameterKeyError,
  parameterValueError,
  postgresMemory,
  quantityError,
  quantityValue,
  rfc3339Error,
} from "./create-forms";
import { subjectOf } from "./write-actions";

import type { KeyValue } from "./create-forms";
import type { ActionDialogFacts } from "./write-actions";

export type ReadState = "loading" | "ready" | "unavailable";

export interface CatalogChoice {
  kind: "ImageCatalog" | "ClusterImageCatalog";
  name: string;
  majors: number[];
}

export interface SecretChoice {
  name: string;
  type?: string;
  /** The `username` key of a basic-auth secret, decoded, when the read could see it. */
  username?: string;
}

export interface BackupChoice {
  name: string;
  cluster: string;
  phase?: string;
}

/** What the reads on open found (F7). `unavailable` is any failure: the pickers degrade, nothing blocks. */
export interface ClusterCreateInputs {
  /** The namespaces the page filter selects, for the default of the form (F4). */
  selectedNamespaces: string[];
  /** The clusters of the namespace, for the collision warning. */
  clusters: string[];
  objectStores: string[];
  catalogs: CatalogChoice[];
  storageClasses: string[];
  secrets: SecretChoice[];
  backups: BackupChoice[];
  /** The default image of the operator, when SPEC-0016 could read it from the deployment. */
  operatorImage?: string;
  reads: Record<"clusters" | "objectStores" | "catalogs" | "storageClasses" | "secrets" | "backups", ReadState>;
}

export function emptyClusterCreateInputs(selectedNamespaces: string[] = []): ClusterCreateInputs {
  return {
    selectedNamespaces,
    clusters: [],
    objectStores: [],
    catalogs: [],
    storageClasses: [],
    secrets: [],
    backups: [],
    reads: {
      clusters: "loading",
      objectStores: "loading",
      catalogs: "loading",
      storageClasses: "loading",
      secrets: "loading",
      backups: "loading",
    },
  };
}

export type ImageSource = "operator" | "catalog" | "name";
export type BootstrapChoice = "initdb" | "recovery";
export type RecoverySource = "backup" | "objectStore";
export type LocaleProvider = "" | "libc" | "icu" | "builtin";
export type SyncMethod = "any" | "first";
export type DataDurability = "" | "required" | "preferred";
export type BackupTarget = "" | "primary" | "prefer-standby";
export type UpdateStrategy = "" | "unsupervised" | "supervised";
export type UpdateMethod = "" | "restart" | "switchover";
export type AntiAffinity = "" | "preferred" | "required";

/** Every value of the form, as typed. Strings stay strings until the body is built. */
export interface ClusterForm {
  namespace: string;
  name: string;
  description: string;
  instances: string;
  imageSource: ImageSource;
  /** `<kind>/<name>` of the picked catalog. */
  catalog: string;
  catalogMajor: string;
  imageName: string;
  storageSize: string;
  storageClass: string;
  walEnabled: boolean;
  walSize: string;
  walClass: string;
  bootstrap: BootstrapChoice;
  initdbDatabase: string;
  initdbOwner: string;
  initdbSecret: string;
  initdbEncoding: string;
  initdbLocaleProvider: LocaleProvider;
  initdbLocale: string;
  initdbDataChecksums: boolean;
  recoverySource: RecoverySource;
  recoveryBackup: string;
  recoveryObjectStore: string;
  /** The folder of the source cluster in the object store: its name, unless it archived under another. */
  recoveryServerName: string;
  recoveryTargetTime: string;
  objectStore: string;
  backupTarget: BackupTarget;
  superuserAccess: boolean;
  superuserSecret: string;
  syncEnabled: boolean;
  syncMethod: SyncMethod;
  syncNumber: string;
  syncDurability: DataDurability;
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
  updateStrategy: UpdateStrategy;
  updateMethod: UpdateMethod;
  parameters: KeyValue[];
  antiAffinity: AntiAffinity;
  topologyKey: string;
  nodeSelector: KeyValue[];
}

export function defaultClusterForm(namespace: string): ClusterForm {
  return {
    namespace,
    name: "",
    description: "",
    instances: "3",
    imageSource: "operator",
    catalog: "",
    catalogMajor: "",
    imageName: "",
    storageSize: "",
    storageClass: "",
    walEnabled: false,
    walSize: "",
    walClass: "",
    bootstrap: "initdb",
    initdbDatabase: "app",
    initdbOwner: "app",
    initdbSecret: "",
    initdbEncoding: "",
    initdbLocaleProvider: "",
    initdbLocale: "",
    initdbDataChecksums: false,
    recoverySource: "backup",
    recoveryBackup: "",
    recoveryObjectStore: "",
    recoveryServerName: "",
    recoveryTargetTime: "",
    objectStore: "",
    backupTarget: "",
    superuserAccess: false,
    superuserSecret: "",
    syncEnabled: false,
    syncMethod: "any",
    syncNumber: "1",
    syncDurability: "",
    requestsCpu: "",
    requestsMemory: "",
    limitsCpu: "",
    limitsMemory: "",
    updateStrategy: "",
    updateMethod: "",
    parameters: [],
    antiAffinity: "",
    topologyKey: "",
    nodeSelector: [],
  };
}

export function catalogKey(catalog: Pick<CatalogChoice, "kind" | "name">): string {
  return `${catalog.kind}/${catalog.name}`;
}

export function pickedCatalog(inputs: ClusterCreateInputs, form: ClusterForm): CatalogChoice | undefined {
  return inputs.catalogs.find((catalog) => catalogKey(catalog) === form.catalog);
}

/** The values the API server and the operator stamp when a field is left out (F8): shown, never sent. */
export interface ClusterEffectiveValues {
  image: string;
  bootstrap: string;
  updateStrategy: "unsupervised";
  updateMethod: "restart";
  superuserAccess: "off";
  backupTarget: "prefer-standby";
  antiAffinity: "preferred";
  dataDurability: "required";
  storageClass: string;
}

export function clusterEffectiveValues(inputs: ClusterCreateInputs): ClusterEffectiveValues {
  return {
    image: inputs.operatorImage ?? "the operator's default image",
    bootstrap: "a new database app owned by app, encoding UTF8, locale C",
    updateStrategy: "unsupervised",
    updateMethod: "restart",
    superuserAccess: "off",
    backupTarget: "prefer-standby",
    antiAffinity: "preferred",
    dataDurability: "required",
    storageClass: "the default storage class of the Kubernetes cluster",
  };
}

/** The fields in reading order, for the reason under OK (F2). */
export const CLUSTER_FIELD_ORDER: readonly string[] = [
  "namespace",
  "name",
  "instances",
  "catalog",
  "catalogMajor",
  "imageName",
  "storageSize",
  "walSize",
  "initdbDatabase",
  "initdbOwner",
  "initdbLocale",
  "recoveryBackup",
  "recoveryObjectStore",
  "recoveryServerName",
  "recoveryTargetTime",
  "syncNumber",
  "requestsCpu",
  "requestsMemory",
  "limitsCpu",
  "limitsMemory",
  "updateStrategy",
  "parameters",
  "topologyKey",
  "nodeSelector",
];

function instancesOf(form: ClusterForm): number {
  return integerError(form.instances, "Instances", 1) ? Number.NaN : Number(form.instances);
}

function sharedBuffersOf(form: ClusterForm): ReturnType<typeof postgresMemory> {
  const row = form.parameters.find((parameter) => parameter.key.trim() === "shared_buffers");
  return row ? postgresMemory(row.value) : undefined;
}

/** Every field that is wrong, with the reason it shows (F6). A field that is fine is absent. */
export function clusterFormErrors(inputs: ClusterCreateInputs, form: ClusterForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };

  if (form.namespace === "") errors.namespace = "A namespace is required";
  put("name", dnsLabelError(form.name, CLUSTER_NAME_MAX));
  put("instances", integerError(form.instances, "Instances", 1));
  const instances = instancesOf(form);

  if (form.imageSource === "catalog") {
    if (form.catalog === "") errors.catalog = "Pick a catalog";
    const catalog = pickedCatalog(inputs, form);
    if (form.catalogMajor === "") errors.catalogMajor = "Pick the PostgreSQL major";
    else if (catalog && !catalog.majors.includes(Number(form.catalogMajor))) {
      errors.catalogMajor = `${catalog.name} lists no image for PostgreSQL ${form.catalogMajor}`;
    }
  } else if (form.imageSource === "name") {
    put("imageName", imageReferenceError(form.imageName));
  }

  put("storageSize", quantityError(form.storageSize, "A storage size"));
  if (form.walEnabled) put("walSize", quantityError(form.walSize, "A WAL volume size"));

  if (form.bootstrap === "initdb") {
    put("initdbDatabase", identifierError(form.initdbDatabase, "A database name"));
    put("initdbOwner", identifierError(form.initdbOwner, "An owner"));
    if (form.initdbLocaleProvider !== "" && form.initdbLocaleProvider !== "libc" && form.initdbLocale === "") {
      errors.initdbLocale = `A locale is required with the ${form.initdbLocaleProvider} provider`;
    }
  } else if (form.recoverySource === "backup") {
    if (form.recoveryBackup === "") errors.recoveryBackup = "Pick the backup to recover from";
    else {
      const backup = inputs.backups.find((candidate) => candidate.name === form.recoveryBackup);
      if (backup && backup.phase !== "completed") {
        errors.recoveryBackup = `${backup.name} is ${backup.phase ?? "not completed"}: only a completed backup can be recovered`;
      }
    }
    if (form.recoveryTargetTime !== "")
      put("recoveryTargetTime", rfc3339Error(form.recoveryTargetTime, "A target time"));
  } else {
    if (form.recoveryObjectStore === "") errors.recoveryObjectStore = "Pick the object store that holds the backups";
    put("recoveryServerName", dnsLabelError(form.recoveryServerName));
    if (
      !errors.recoveryServerName &&
      !errors.name &&
      form.objectStore !== "" &&
      form.objectStore === form.recoveryObjectStore &&
      form.recoveryServerName === form.name
    ) {
      errors.recoveryServerName =
        "The new cluster would archive into the folder it recovers from: give it another name, or archive to another store";
    }
    if (form.recoveryTargetTime !== "")
      put("recoveryTargetTime", rfc3339Error(form.recoveryTargetTime, "A target time"));
  }

  if (form.syncEnabled) {
    const numberError = integerError(form.syncNumber, "The number of synchronous replicas", 1);
    if (numberError) errors.syncNumber = numberError;
    else if (!Number.isNaN(instances) && Number(form.syncNumber) >= instances) {
      errors.syncNumber = `The number of synchronous replicas must be below the instances (${instances})`;
    }
  }

  for (const [key, what] of [
    ["requestsCpu", "A CPU request"],
    ["requestsMemory", "A memory request"],
    ["limitsCpu", "A CPU limit"],
    ["limitsMemory", "A memory limit"],
  ] as const) {
    if (form[key] !== "") put(key, quantityError(form[key], what, key.endsWith("Cpu") ? "500m" : "1Gi"));
  }
  const requestsCpu = quantityValue(form.requestsCpu);
  const limitsCpu = quantityValue(form.limitsCpu);
  if (requestsCpu !== undefined && limitsCpu !== undefined && requestsCpu > limitsCpu) {
    errors.limitsCpu = "The CPU limit is not below the request";
  }
  const requestsMemory = quantityValue(form.requestsMemory);
  const limitsMemory = quantityValue(form.limitsMemory);
  if (requestsMemory !== undefined && limitsMemory !== undefined && requestsMemory > limitsMemory) {
    errors.limitsMemory = "The memory limit is not below the request";
  }
  const sharedBuffers = sharedBuffersOf(form);
  if (requestsMemory !== undefined && sharedBuffers && requestsMemory < sharedBuffers.bytes) {
    errors.requestsMemory = "The memory request is not below shared_buffers";
  }

  if (form.updateStrategy === "supervised" && instances === 1) {
    errors.updateStrategy = "A supervised strategy is refused on a cluster of one instance";
  }

  const duplicates = duplicateKeys(form.parameters);
  form.parameters.forEach((parameter, index) => {
    const key = parameter.key.trim();
    const keyError = parameterKeyError(key) ?? (duplicates.has(key) ? `${key} is set twice` : undefined);
    if (keyError) errors[`parameters.${index}.key`] = keyError;
    else
      put(
        `parameters.${index}.value`,
        parameterValueError(key, parameter.value, Number.isNaN(instances) ? 1 : instances),
      );
  });
  if (Object.keys(errors).some((key) => key.startsWith("parameters."))) errors.parameters = "A parameter is wrong";

  if (form.antiAffinity !== "" && form.topologyKey !== "") put("topologyKey", labelKeyError(form.topologyKey));
  const selectorDuplicates = duplicateKeys(form.nodeSelector);
  form.nodeSelector.forEach((row, index) => {
    const key = row.key.trim();
    const keyError = labelKeyError(key) ?? (selectorDuplicates.has(key) ? `${key} is set twice` : undefined);
    if (keyError) errors[`nodeSelector.${index}.key`] = keyError;
    else put(`nodeSelector.${index}.value`, labelValueError(row.value));
  });
  if (Object.keys(errors).some((key) => key.startsWith("nodeSelector.")))
    errors.nodeSelector = "A node selector is wrong";

  return errors;
}

/** What is said at a field without blocking (F5, F7): a collision, a name the read did not see. */
export function clusterFormWarnings(inputs: ClusterCreateInputs, form: ClusterForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const put = (key: string, warning: string | undefined) => {
    if (warning) warnings[key] = warning;
  };
  const unseen = (read: ReadState, known: readonly string[], value: string, what: string) => {
    if (value === "" || read !== "ready" || known.includes(value)) return undefined;
    return `No ${what} named ${value} was found in the namespace: the cluster will wait until it exists`;
  };

  put("name", collisionWarning("cluster", form.name, inputs.clusters));
  put("objectStore", unseen(inputs.reads.objectStores, inputs.objectStores, form.objectStore, "object store"));
  put(
    "recoveryObjectStore",
    unseen(inputs.reads.objectStores, inputs.objectStores, form.recoveryObjectStore, "object store"),
  );
  if (form.bootstrap === "recovery" && form.recoverySource === "backup") {
    put(
      "recoveryBackup",
      unseen(
        inputs.reads.backups,
        inputs.backups.map((backup) => backup.name),
        form.recoveryBackup,
        "backup",
      ),
    );
  }
  const secretNames = inputs.secrets.map((secret) => secret.name);
  put("initdbSecret", unseen(inputs.reads.secrets, secretNames, form.initdbSecret, "secret"));
  put("superuserSecret", unseen(inputs.reads.secrets, secretNames, form.superuserSecret, "secret"));
  for (const key of ["initdbSecret", "superuserSecret"] as const) {
    const secret = inputs.secrets.find((candidate) => candidate.name === form[key]);
    if (secret && secret.type && secret.type !== "kubernetes.io/basic-auth") {
      warnings[key] = `${secret.name} is a ${secret.type} secret: the operator expects kubernetes.io/basic-auth`;
    }
  }
  if (
    form.storageClass !== "" &&
    inputs.reads.storageClasses === "ready" &&
    !inputs.storageClasses.includes(form.storageClass)
  ) {
    warnings.storageClass = `No storage class named ${form.storageClass} was found: the volumes will stay pending until it exists`;
  }
  if (
    form.imageSource === "catalog" &&
    form.catalog !== "" &&
    inputs.reads.catalogs === "ready" &&
    !pickedCatalog(inputs, form)
  ) {
    warnings.catalog = `No catalog named ${form.catalog} was found: the cluster would report an invalid catalog`;
  }
  return warnings;
}

/** The body of the one `create` (F12): only what the user decided, in the order the form presents it. */
export function clusterCreateBody(form: ClusterForm): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  if (form.description.trim() !== "") spec.description = form.description.trim();
  spec.instances = Number(form.instances);

  if (form.imageSource === "catalog" && form.catalog !== "") {
    const [kind, ...name] = form.catalog.split("/");
    spec.imageCatalogRef = {
      apiGroup: "postgresql.cnpg.io",
      kind,
      name: name.join("/"),
      major: Number(form.catalogMajor),
    };
  } else if (form.imageSource === "name" && form.imageName.trim() !== "") {
    spec.imageName = form.imageName.trim();
  }

  spec.storage = { size: form.storageSize.trim(), ...(form.storageClass ? { storageClass: form.storageClass } : {}) };
  if (form.walEnabled) {
    spec.walStorage = { size: form.walSize.trim(), ...(form.walClass ? { storageClass: form.walClass } : {}) };
  }

  if (form.bootstrap === "initdb") {
    const initdb: Record<string, unknown> = { database: form.initdbDatabase, owner: form.initdbOwner };
    if (form.initdbSecret) initdb.secret = { name: form.initdbSecret };
    if (form.initdbEncoding) initdb.encoding = form.initdbEncoding;
    if (form.initdbLocaleProvider) initdb.localeProvider = form.initdbLocaleProvider;
    if (form.initdbLocale) {
      const key =
        form.initdbLocaleProvider === "icu"
          ? "icuLocale"
          : form.initdbLocaleProvider === "builtin"
            ? "builtinLocale"
            : "locale";
      initdb[key] = form.initdbLocale;
    }
    if (form.initdbDataChecksums) initdb.dataChecksums = true;
    spec.bootstrap = { initdb };
  } else {
    const recovery: Record<string, unknown> = {};
    if (form.recoverySource === "backup") {
      recovery.backup = { name: form.recoveryBackup };
    } else {
      recovery.source = form.recoveryServerName;
    }
    if (form.recoveryTargetTime.trim() !== "") recovery.recoveryTarget = { targetTime: form.recoveryTargetTime.trim() };
    spec.bootstrap = { recovery };
    if (form.recoverySource === "objectStore") {
      spec.externalClusters = [
        {
          name: form.recoveryServerName,
          plugin: {
            name: BARMAN_CLOUD_PLUGIN_NAME,
            parameters: { barmanObjectName: form.recoveryObjectStore, serverName: form.recoveryServerName },
          },
        },
      ];
    }
  }

  if (form.objectStore) {
    spec.plugins = [
      { name: BARMAN_CLOUD_PLUGIN_NAME, isWALArchiver: true, parameters: { barmanObjectName: form.objectStore } },
    ];
  }
  if (form.backupTarget) spec.backup = { target: form.backupTarget };

  if (form.superuserAccess) {
    spec.enableSuperuserAccess = true;
    if (form.superuserSecret) spec.superuserSecret = { name: form.superuserSecret };
  }

  const postgresql: Record<string, unknown> = {};
  if (form.syncEnabled) {
    postgresql.synchronous = {
      method: form.syncMethod,
      number: Number(form.syncNumber),
      ...(form.syncDurability ? { dataDurability: form.syncDurability } : {}),
    };
  }
  const parameters = keyValueObject(form.parameters);
  if (parameters) postgresql.parameters = parameters;
  if (Object.keys(postgresql).length > 0) spec.postgresql = postgresql;

  const requests = {
    ...(form.requestsCpu ? { cpu: form.requestsCpu } : {}),
    ...(form.requestsMemory ? { memory: form.requestsMemory } : {}),
  };
  const limits = {
    ...(form.limitsCpu ? { cpu: form.limitsCpu } : {}),
    ...(form.limitsMemory ? { memory: form.limitsMemory } : {}),
  };
  const resources = {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
  if (Object.keys(resources).length > 0) spec.resources = resources;

  if (form.updateStrategy) spec.primaryUpdateStrategy = form.updateStrategy;
  if (form.updateMethod) spec.primaryUpdateMethod = form.updateMethod;

  const affinity: Record<string, unknown> = {};
  if (form.antiAffinity) {
    affinity.podAntiAffinityType = form.antiAffinity;
    if (form.topologyKey.trim() !== "") affinity.topologyKey = form.topologyKey.trim();
  }
  const nodeSelector = keyValueObject(form.nodeSelector);
  if (nodeSelector) affinity.nodeSelector = nodeSelector;
  if (Object.keys(affinity).length > 0) spec.affinity = affinity;

  return {
    apiVersion: CNPG_API_VERSION,
    kind: "Cluster",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

function imageWords(inputs: ClusterCreateInputs, form: ClusterForm): string {
  if (form.imageSource === "catalog") {
    const catalog = pickedCatalog(inputs, form);
    return `PostgreSQL ${form.catalogMajor || "?"} from the catalog ${catalog?.name ?? (form.catalog || "?")}`;
  }
  if (form.imageSource === "name") return `image ${form.imageName || "?"}`;
  return `image ${clusterEffectiveValues(inputs).image}`;
}

function bootstrapWords(form: ClusterForm): string {
  if (form.bootstrap === "initdb") return `a new database ${form.initdbDatabase} owned by ${form.initdbOwner}`;
  const upTo = form.recoveryTargetTime ? ` up to ${form.recoveryTargetTime}` : "";
  return form.recoverySource === "backup"
    ? `recovery from the backup ${form.recoveryBackup || "?"}${upTo}`
    : `recovery of ${form.recoveryServerName || "?"} from the object store ${form.recoveryObjectStore || "?"}${upTo}`;
}

/** What the operator will create from the object, said before the click (F2). */
export function clusterCreateNotes(_inputs: ClusterCreateInputs, form: ClusterForm): string[] {
  const instances = instancesOf(form);
  const count = Number.isNaN(instances) ? "?" : String(instances);
  const name = form.name || "<name>";
  const notes: string[] = [];
  notes.push(
    `The operator creates the pods ${name}-1${count === "1" ? "" : ` to ${name}-${count}`}, each on a volume of ${form.storageSize || "?"}${
      form.walEnabled ? ` and a WAL volume of ${form.walSize || "?"}` : ""
    }, the services ${name}-rw, ${name}-ro and ${name}-r, and the secrets ${name}-app${form.superuserAccess ? ` and ${name}-superuser` : ""}.`,
  );
  notes.push(
    `Bootstrap: ${bootstrapWords(form)}. The bootstrap section is read once, when the first instance is created.`,
  );
  if (form.objectStore) {
    notes.push(
      `WAL is archived to the object store ${form.objectStore} through the Barman Cloud plugin: backups and point in time recovery become possible.`,
    );
  }
  if (form.syncEnabled) {
    notes.push(
      `${form.syncNumber} synchronous replica${form.syncNumber === "1" ? "" : "s"} (${form.syncMethod}${
        form.syncDurability ? `, ${form.syncDurability} durability` : ""
      }): a commit waits for ${form.syncMethod === "first" ? "the first" : "any"} ${form.syncNumber} of the standbys.`,
    );
  }
  if (form.updateStrategy === "" && form.updateMethod === "") {
    notes.push("Updates roll out unsupervised, the primary last by a restart, unless the strategy is changed later.");
  }
  return notes;
}

/** What it costs (F2). */
export function clusterCreateWarnings(_inputs: ClusterCreateInputs, form: ClusterForm): string[] {
  const warnings: string[] = [];
  const instances = instancesOf(form);
  if (instances === 1) warnings.push("One instance: no failover, and no standby to read from.");
  if (!form.objectStore) {
    warnings.push("No object store: no WAL archiving, so no backup and no point in time recovery for this cluster.");
  }
  if (!form.requestsCpu && !form.requestsMemory) {
    warnings.push("No resource requests: the pods get the BestEffort class and are the first evicted under pressure.");
  } else if (form.requestsCpu !== form.limitsCpu || form.requestsMemory !== form.limitsMemory) {
    warnings.push(
      "Requests and limits differ: the pods miss the Guaranteed class the operator recommends for a database.",
    );
  }
  if (form.updateStrategy === "supervised") {
    warnings.push("Supervised updates: after every change the primary waits for a switchover by hand.");
  }
  if (
    form.syncEnabled &&
    !Number.isNaN(instances) &&
    Number(form.syncNumber) === instances - 1 &&
    form.syncDurability !== "preferred"
  ) {
    warnings.push("Every standby is synchronous with required durability: one lost standby blocks every write.");
  }
  if (form.bootstrap === "recovery") {
    warnings.push(
      "Recovery replays the backups and the WAL of the source: the new cluster starts with that data, not empty.",
    );
  }
  return warnings;
}

function writeFacts(inputs: ClusterCreateInputs, form: ClusterForm): string {
  const parts = [
    `${form.instances || "?"} instance${form.instances === "1" ? "" : "s"}`,
    imageWords(inputs, form),
    `storage ${form.storageSize || "?"}${form.storageClass ? ` (${form.storageClass})` : ""}`,
    bootstrapWords(form),
    form.objectStore ? `WAL archiving to ${form.objectStore}` : "no WAL archiving",
  ];
  return parts.join(", ");
}

/** The facts of the dialog, recomputed as the form changes (F2). */
export function clusterCreateFacts(inputs: ClusterCreateInputs, form: ClusterForm): ActionDialogFacts {
  return {
    subject: subjectOf("Cluster", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [{ verb: "create", text: createLine("Cluster", form.namespace, form.name, writeFacts(inputs, form)) }],
    notes: clusterCreateNotes(inputs, form),
    warnings: clusterCreateWarnings(inputs, form),
  };
}

/** Why OK is disabled, or undefined (F2): the first wrong field in reading order, else what the access review said. */
export function clusterCreateBlockReason(
  inputs: ClusterCreateInputs,
  form: ClusterForm,
  accessReason?: string,
): string | undefined {
  return firstError(CLUSTER_FIELD_ORDER, clusterFormErrors(inputs, form)) ?? accessReason;
}

export function clusterCreateSuccessMessage(namespace: string, name: string): string {
  return `Requested the PostgreSQL cluster ${namespace}/${name}: the operator creates its instances now`;
}

/** `objectNameError` is what the other kinds use; a cluster name is stricter, and this says why. */
export const CLUSTER_NAME_HINT = `A DNS label of ${CLUSTER_NAME_MAX} characters at most: it becomes the prefix of the pods, the volumes, the services and the secrets.`;
export const OBJECT_NAME_HINT = "Lowercase letters, digits, dashes and dots.";
export { objectNameError };
