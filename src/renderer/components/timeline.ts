/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the cluster timeline (SPEC-0017): the Kubernetes events of a
// cluster and of everything it owns, the facts that outlive the events
// (backups, the change of primary, the conditions, the lease) and what is
// scheduled to come, on one time axis, newest first.

import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { classifyBackup } from "./backup-health";
import { certificateFacts } from "./cluster-health";
import { parseGoTime } from "./go-time";
import { leaseFacts } from "./leases";

import type { Pooler } from "../api/cnpg/pooler-v1";
import type { LeaseLike } from "../api/core/lease";
import type { HostStatusClass } from "./cluster-health";

export type TimelineCategory = "Event" | "Backup" | "Primary" | "Condition" | "Scheduled";

export const TIMELINE_CATEGORIES: readonly TimelineCategory[] = [
  "Event",
  "Backup",
  "Primary",
  "Condition",
  "Scheduled",
];

export interface TimelineObject {
  kind: string;
  name: string;
  namespace: string;
}

export interface TimelineEntry {
  id: string;
  time: Date;
  category: TimelineCategory;
  level: HostStatusClass;
  title: string;
  detail?: string;
  object?: TimelineObject;
  /** How many times the API server saw the event, when more than once. */
  count?: number;
  /** Still to come. */
  future: boolean;
}

/** A Kubernetes event as the host's store hands it over. */
export interface KubeEventLike {
  metadata?: { name?: string; namespace?: string; uid?: string; creationTimestamp?: string };
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  reason?: string;
  message?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  series?: { count?: number; lastObservedTime?: string };
  source?: { component?: string };
  reportingComponent?: string;
}

interface NamedObject {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Partial<Record<string, string>> };
}

export interface TimelineInput {
  cluster: Cluster;
  /** Every cluster of the namespace, to tell `pg` apart from `pg-2` when an owned object is already gone. */
  clusters?: readonly Cluster[];
  events?: readonly KubeEventLike[];
  backups?: readonly Backup[];
  schedules?: readonly ScheduledBackup[];
  poolers?: readonly Pooler[];
  /** Pods, PVCs and jobs of the namespace: the ones labelled with the cluster are its own. */
  owned?: readonly NamedObject[];
  lease?: LeaseLike;
  now?: Date;
}

export const CLUSTER_LABEL = "cnpg.io/cluster";

/** Kinds whose objects the operator names after the cluster, so a prefix tells the owner when the object is gone. */
const PREFIXED_KINDS: readonly string[] = ["Pod", "PersistentVolumeClaim", "Job", "PodDisruptionBudget", "Service"];

function eventTime(event: KubeEventLike): Date | undefined {
  return (
    parseGoTime(event.series?.lastObservedTime ?? undefined) ??
    parseGoTime(event.lastTimestamp ?? undefined) ??
    parseGoTime(event.eventTime ?? undefined) ??
    parseGoTime(event.firstTimestamp ?? undefined) ??
    parseGoTime(event.metadata?.creationTimestamp)
  );
}

/** Whether an event is about the cluster or about something it owns. */
export function isEventOfCluster(event: KubeEventLike, input: TimelineInput): boolean {
  const { cluster } = input;
  const name = cluster.metadata?.name ?? "";
  const namespace = cluster.metadata?.namespace ?? "";
  const involved = event.involvedObject;
  if (!involved?.name || (involved.namespace ?? event.metadata?.namespace) !== namespace) return false;
  const kind = involved.kind ?? "";

  if (kind === "Cluster") return involved.name === name;
  if (kind === "Backup") {
    return (input.backups ?? []).some(
      (backup) => backup.metadata?.name === involved.name && Backup.getClusterName(backup) === name,
    );
  }
  if (kind === "ScheduledBackup") {
    return (input.schedules ?? []).some(
      (schedule) => schedule.metadata?.name === involved.name && schedule.spec?.cluster?.name === name,
    );
  }
  const poolerNames = (input.poolers ?? [])
    .filter((pooler) => pooler.spec?.cluster?.name === name && pooler.metadata?.namespace === namespace)
    .map((pooler) => pooler.metadata?.name ?? "");
  if (kind === "Pooler") return poolerNames.includes(involved.name);

  // Something the cluster owns and that is still there says so with its label.
  const known = (input.owned ?? []).find(
    (object) => object.metadata?.name === involved.name && (object.kind ?? kind) === kind,
  );
  if (known) return known.metadata?.labels?.[CLUSTER_LABEL] === name;
  if ((cluster.status?.instanceNames ?? []).includes(involved.name)) return true;

  // Gone already: the name tells, unless another cluster of the namespace has a longer matching name.
  if (!PREFIXED_KINDS.includes(kind)) return false;
  if (involved.name !== name && !involved.name.startsWith(`${name}-`)) return false;
  return !(input.clusters ?? []).some((other) => {
    const otherName = other.metadata?.name ?? "";
    return (
      other.metadata?.namespace === namespace &&
      otherName.length > name.length &&
      (involved.name === otherName || involved.name?.startsWith(`${otherName}-`))
    );
  });
}

function eventEntry(event: KubeEventLike): TimelineEntry | undefined {
  const time = eventTime(event);
  if (!time) return undefined;
  const involved = event.involvedObject;
  const count = event.series?.count ?? event.count;
  return {
    id: `event/${event.metadata?.uid ?? event.metadata?.name ?? `${involved?.name}/${event.reason}/${time.getTime()}`}`,
    time,
    category: "Event",
    level: event.type === "Warning" ? "warning" : "info",
    title: `${event.reason ?? "Event"}: ${involved?.kind ?? ""} ${involved?.name ?? ""}`.trim(),
    detail: event.message?.trim() || undefined,
    object: involved?.name
      ? { kind: involved.kind ?? "", name: involved.name, namespace: involved.namespace ?? "" }
      : undefined,
    count: count && count > 1 ? count : undefined,
    future: false,
  };
}

function backupEntries(backup: Backup, now: Date): TimelineEntry[] {
  const name = backup.metadata?.name ?? "";
  const object = { kind: "Backup", name, namespace: backup.metadata?.namespace ?? "" };
  const started = parseGoTime(backup.status?.startedAt);
  const stopped = parseGoTime(backup.status?.stoppedAt);
  const health = classifyBackup(backup, now);
  const entries: TimelineEntry[] = [];
  if (started) {
    entries.push({
      id: `backup/${name}/started`,
      time: started,
      category: "Backup",
      level: "info",
      title: `Backup ${name} started`,
      detail: backup.spec?.method ? `method ${backup.spec.method}` : undefined,
      object,
      future: false,
    });
  }
  if (health.state === "Completed" && stopped) {
    entries.push({
      id: `backup/${name}/completed`,
      time: stopped,
      category: "Backup",
      level: "success",
      title: `Backup ${name} completed`,
      detail: health.reason,
      object,
      future: false,
    });
  } else if (health.state === "Failed") {
    const time = stopped ?? started ?? parseGoTime(backup.metadata?.creationTimestamp);
    if (time) {
      entries.push({
        id: `backup/${name}/failed`,
        time,
        category: "Backup",
        level: "error",
        title: `Backup ${name} failed`,
        detail: health.reason,
        object,
        future: false,
      });
    }
  }
  return entries;
}

function conditionLevel(type: string, status: string): HostStatusClass {
  if (status === "True") return type === "Ready" || type === "ContinuousArchiving" ? "success" : "info";
  if (type === "ContinuousArchiving") return "error";
  return type === "Ready" ? "warning" : "info";
}

export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { cluster } = input;
  const now = input.now ?? new Date();
  const name = cluster.metadata?.name ?? "";
  const namespace = cluster.metadata?.namespace ?? "";
  const self = { kind: "Cluster", name, namespace };
  const entries: TimelineEntry[] = [];

  for (const event of input.events ?? []) {
    if (!isEventOfCluster(event, input)) continue;
    const entry = eventEntry(event);
    if (entry) entries.push(entry);
  }

  for (const backup of input.backups ?? []) {
    if (Backup.getClusterName(backup) !== name || backup.metadata?.namespace !== namespace) continue;
    entries.push(...backupEntries(backup, now));
  }

  const created = parseGoTime(cluster.metadata?.creationTimestamp);
  if (created) {
    entries.push({
      id: "cluster/created",
      time: created,
      category: "Condition",
      level: "info",
      title: `Cluster ${name} created`,
      object: self,
      future: false,
    });
  }

  const primary = Cluster.getPrimary(cluster);
  const primarySince = parseGoTime(cluster.status?.currentPrimaryTimestamp);
  if (primary && primarySince) {
    entries.push({
      id: "primary/current",
      time: primarySince,
      category: "Primary",
      level: "info",
      title: `${primary} became primary`,
      object: { kind: "Pod", name: primary, namespace },
      future: false,
    });
  }
  const failingSince = parseGoTime(cluster.status?.currentPrimaryFailingSinceTimestamp);
  if (primary && failingSince) {
    entries.push({
      id: "primary/failing",
      time: failingSince,
      category: "Primary",
      level: "warning",
      title: `The primary ${primary} started failing`,
      detail: "The operator waits for the failover delay before it promotes another instance",
      object: { kind: "Pod", name: primary, namespace },
      future: false,
    });
  }
  if (input.lease) {
    const lease = leaseFacts(input.lease, now);
    if (lease.holder && lease.acquiredAt) {
      entries.push({
        id: "primary/lease",
        time: lease.acquiredAt,
        category: "Primary",
        level: "info",
        title: `${lease.holder} acquired the primary lease`,
        detail: `${lease.transitions} ${lease.transitions === 1 ? "transition" : "transitions"} so far`,
        object: { kind: "Pod", name: lease.holder, namespace },
        future: false,
      });
    }
  }

  for (const condition of cluster.status?.conditions ?? []) {
    const time = parseGoTime(condition.lastTransitionTime);
    if (!time) continue;
    entries.push({
      id: `condition/${condition.type}`,
      time,
      category: "Condition",
      level: conditionLevel(condition.type, condition.status),
      title: `${condition.type} became ${condition.status}`,
      detail: condition.message?.trim() || condition.reason || undefined,
      object: self,
      future: false,
    });
  }

  for (const schedule of input.schedules ?? []) {
    if (schedule.spec?.cluster?.name !== name || schedule.metadata?.namespace !== namespace) continue;
    if (ScheduledBackup.isSuspended(schedule)) continue;
    const next = parseGoTime(schedule.status?.nextScheduleTime);
    if (!next || next.getTime() <= now.getTime()) continue;
    const scheduleName = schedule.metadata?.name ?? "";
    entries.push({
      id: `scheduled/backup/${scheduleName}`,
      time: next,
      category: "Scheduled",
      level: "info",
      title: `Next backup of ${scheduleName}`,
      object: { kind: "ScheduledBackup", name: scheduleName, namespace },
      future: true,
    });
  }
  // The certificates expire together more often than not: one entry for the first to go, not four in a row.
  const expiring = certificateFacts(cluster, now)
    .filter((certificate) => certificate.expiresAt && certificate.expiresAt.getTime() > now.getTime())
    .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));
  const [first] = expiring;
  if (first?.expiresAt) {
    const others = expiring.length - 1;
    entries.push({
      id: "scheduled/certificate",
      time: first.expiresAt,
      category: "Scheduled",
      level: first.state === "expiring" ? "warning" : "info",
      title: `The ${first.role} certificate expires`,
      detail:
        others > 0
          ? `The first of ${expiring.length} certificates to expire; the operator renews its own before then`
          : "The operator renews its own before then",
      object: first.secretName ? { kind: "Secret", name: first.secretName, namespace } : undefined,
      future: true,
    });
  }

  return entries.sort((a, b) => b.time.getTime() - a.time.getTime() || a.id.localeCompare(b.id));
}

export interface TimelineFilter {
  /** Empty: every category. */
  categories: readonly TimelineCategory[];
  /** Only warnings and errors. */
  attention: boolean;
}

export function filterTimeline(entries: readonly TimelineEntry[], filter: TimelineFilter): TimelineEntry[] {
  return entries.filter((entry) => {
    if (filter.categories.length > 0 && !filter.categories.includes(entry.category)) return false;
    if (filter.attention && entry.level !== "warning" && entry.level !== "error") return false;
    return true;
  });
}

export function categoryCounts(entries: readonly TimelineEntry[]): { category: TimelineCategory; count: number }[] {
  return TIMELINE_CATEGORIES.map((category) => ({
    category,
    count: entries.filter((entry) => entry.category === category).length,
  })).filter((item) => item.count > 0);
}

export interface TimelineGroup {
  /** "To come", "Today", "Yesterday" or the local date. */
  label: string;
  entries: TimelineEntry[];
}

function dayKey(time: Date): string {
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")}`;
}

/** The entries by local day, newest first; what is to come in a group of its own on top. */
export function groupTimeline(entries: readonly TimelineEntry[], now: Date = new Date()): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  for (const entry of entries) {
    const key = entry.future ? "To come" : dayKey(entry.time);
    const label = key === today ? "Today" : key === yesterday ? "Yesterday" : key;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}
