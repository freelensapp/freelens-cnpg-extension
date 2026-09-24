/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The volume snapshot kinds of `snapshot.storage.k8s.io/v1` as the Create
// Cluster form reads them (SPEC-0029): the snapshots of a namespace, with the
// facts the operator stamps on the ones it takes, and the snapshot classes of
// the Kubernetes cluster. List only, through a KubeApi of the extension's own
// that registers nothing with the host: the extension has no page for the
// kinds, and a Kubernetes cluster without the CRDs answers 404, which every
// reader treats as "no snapshot support", never as an error.

import { Renderer } from "@freelensapp/extensions";

import type { CnpgKubeObjectCRD } from "../types";

export const SNAPSHOT_API_VERSION = "snapshot.storage.k8s.io/v1";
export const SNAPSHOT_API_GROUP = "snapshot.storage.k8s.io";
export const VOLUME_SNAPSHOT_CRD_NAME = "volumesnapshots.snapshot.storage.k8s.io";

/**
 * What the operator writes on the snapshots it takes (v1.30.0, read on a real
 * backup): the role of the volume is an annotation copied from the PVC, the
 * tablespace, the backup, the cluster and the date are labels, hot or cold is
 * an annotation. The readers below look in both places.
 */
export const PVC_ROLE_LABEL = "cnpg.io/pvcRole";
export const TABLESPACE_NAME_LABEL = "cnpg.io/tablespaceName";
export const BACKUP_NAME_LABEL = "cnpg.io/backupName";
export const CLUSTER_LABEL = "cnpg.io/cluster";
export const BACKUP_DATE_LABEL = "cnpg.io/backupDate";
export const ONLINE_BACKUP_ANNOTATION = "cnpg.io/onlineBackup";

export type SnapshotRole = "PG_DATA" | "PG_WAL" | "PG_TABLESPACE";

export interface VolumeSnapshotSpec {
  source?: { persistentVolumeClaimName?: string; volumeSnapshotContentName?: string };
  volumeSnapshotClassName?: string;
}

export interface VolumeSnapshotStatus {
  readyToUse?: boolean;
  boundVolumeSnapshotContentName?: string;
  creationTime?: string;
  restoreSize?: string;
  error?: { message?: string; time?: string };
}

export class VolumeSnapshot extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  VolumeSnapshotStatus,
  VolumeSnapshotSpec
> {
  static readonly kind = "VolumeSnapshot";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${SNAPSHOT_API_VERSION}/volumesnapshots`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [SNAPSHOT_API_VERSION],
    plural: "volumesnapshots",
    singular: "volumesnapshot",
    shortNames: ["vs"],
    title: "Volume Snapshots",
  };
}

/** A VolumeSnapshotClass keeps its facts at the top level, next to the metadata. */
export class VolumeSnapshotClass extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  Record<string, never>,
  Record<string, never>
> {
  static readonly kind = "VolumeSnapshotClass";
  static readonly namespaced = false;
  static readonly apiBase = `/apis/${SNAPSHOT_API_VERSION}/volumesnapshotclasses`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [SNAPSHOT_API_VERSION],
    plural: "volumesnapshotclasses",
    singular: "volumesnapshotclass",
    shortNames: ["vsclass", "vsclasses"],
    title: "Volume Snapshot Classes",
  };

  declare driver?: string;
  declare deletionPolicy?: string;
  declare parameters?: Record<string, string>;
}

let snapshotApi: Renderer.K8sApi.KubeApi<VolumeSnapshot> | undefined;
let snapshotClassApi: Renderer.K8sApi.KubeApi<VolumeSnapshotClass> | undefined;

/** The reader of the snapshots of a namespace, built once, registered with nothing. */
export function volumeSnapshotApi(): Renderer.K8sApi.KubeApi<VolumeSnapshot> {
  snapshotApi ??= new Renderer.K8sApi.KubeApi<VolumeSnapshot>({
    objectConstructor: VolumeSnapshot,
    autoRegister: false,
  });
  return snapshotApi;
}

/** The reader of the snapshot classes of the Kubernetes cluster, built once, registered with nothing. */
export function volumeSnapshotClassApi(): Renderer.K8sApi.KubeApi<VolumeSnapshotClass> {
  snapshotClassApi ??= new Renderer.K8sApi.KubeApi<VolumeSnapshotClass>({
    objectConstructor: VolumeSnapshotClass,
    autoRegister: false,
  });
  return snapshotClassApi;
}

/** What a picker says about one snapshot: the facts the operator stamped, and whether it can be restored. */
export interface SnapshotFacts {
  name: string;
  /** `PG_DATA`, `PG_WAL` or `PG_TABLESPACE` when the operator took it; any other value as found; absent otherwise. */
  role?: string;
  tablespace?: string;
  backup?: string;
  cluster?: string;
  /** `YYYY-MM-DD` from the operator's date label, else the day of the snapshot's creation time. */
  date?: string;
  /** True for a hot snapshot, false for a cold one, absent when the operator did not say. */
  hot?: boolean;
  ready: boolean;
  className?: string;
}

/** The shape the facts are read from: a KubeObject, or the plain JSON of one. */
export interface SnapshotLike {
  metadata?: {
    name?: string;
    labels?: Partial<Record<string, string>>;
    annotations?: Partial<Record<string, string>>;
  };
  spec?: VolumeSnapshotSpec;
  status?: VolumeSnapshotStatus;
}

function backupDate(label: string | undefined, creationTime: string | undefined): string | undefined {
  if (label && /^\d{8}$/.test(label)) return `${label.slice(0, 4)}-${label.slice(4, 6)}-${label.slice(6, 8)}`;
  if (creationTime && /^\d{4}-\d{2}-\d{2}/.test(creationTime)) return creationTime.slice(0, 10);
  return undefined;
}

export function snapshotFacts(snapshot: SnapshotLike): SnapshotFacts {
  const labels: Partial<Record<string, string>> = snapshot.metadata?.labels ?? {};
  const annotations: Partial<Record<string, string>> = snapshot.metadata?.annotations ?? {};
  const online = annotations[ONLINE_BACKUP_ANNOTATION] ?? labels[ONLINE_BACKUP_ANNOTATION];
  return {
    name: snapshot.metadata?.name ?? "",
    role: annotations[PVC_ROLE_LABEL] ?? labels[PVC_ROLE_LABEL],
    tablespace: labels[TABLESPACE_NAME_LABEL] ?? annotations[TABLESPACE_NAME_LABEL],
    backup: labels[BACKUP_NAME_LABEL] ?? annotations[BACKUP_NAME_LABEL],
    cluster: labels[CLUSTER_LABEL] ?? annotations[CLUSTER_LABEL],
    date: backupDate(labels[BACKUP_DATE_LABEL] ?? annotations[BACKUP_DATE_LABEL], snapshot.status?.creationTime),
    hot: online === "true" ? true : online === "false" ? false : undefined,
    ready: snapshot.status?.readyToUse === true,
    className: snapshot.spec?.volumeSnapshotClassName,
  };
}

/** One line for a picker: the backup, the cluster, the day, hot or cold. */
export function snapshotLabel(facts: SnapshotFacts): string {
  const parts = [
    facts.backup ? `backup ${facts.backup}` : undefined,
    facts.cluster ? `of ${facts.cluster}` : undefined,
    facts.date,
    facts.hot === undefined ? undefined : facts.hot ? "hot" : "cold",
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${facts.name} (${parts.join(", ")})` : facts.name;
}

/** Why a snapshot is dimmed in a picker of the given role, or undefined when it is the right kind and ready. */
export function snapshotReason(facts: SnapshotFacts, role: SnapshotRole, tablespace?: string): string | undefined {
  if (!facts.ready) return "not ready to use yet";
  if (facts.role === undefined) return "not taken by the operator: its content is unknown";
  if (facts.role !== role) return `a ${facts.role} snapshot, not ${role}`;
  if (role === "PG_TABLESPACE" && tablespace !== undefined && facts.tablespace !== tablespace) {
    return `the snapshot of the tablespace ${facts.tablespace ?? "?"}, not ${tablespace}`;
  }
  return undefined;
}

/** The snapshots of the wanted kind first, newest first, the others after, so the right one is at the top. */
export function orderSnapshots(
  snapshots: readonly SnapshotFacts[],
  role: SnapshotRole,
  tablespace?: string,
): SnapshotFacts[] {
  const rank = (facts: SnapshotFacts) => (snapshotReason(facts, role, tablespace) === undefined ? 0 : 1);
  return [...snapshots].sort(
    (a, b) => rank(a) - rank(b) || (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name),
  );
}
