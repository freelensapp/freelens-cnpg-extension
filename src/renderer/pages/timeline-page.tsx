/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Timeline page (SPEC-0017): what happened to a cluster and in which
// order. The Kubernetes events of the cluster and of everything it owns sit on
// one axis with the facts that outlive them (backups, the change of primary,
// the conditions, the primary lease) and with what is scheduled to come. All
// of it comes from stores the host watches: nothing is polled.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { getLeaseStore } from "../api/core/lease";
import { humanizeRelative } from "../components/backup-health";
import { ClusterPickerPage } from "../components/cluster-picker-page";
import { withErrorPage } from "../components/error-page";
import { leaseOfCluster } from "../components/leases";
import liveStyles from "../components/live/live.module.scss";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import { buildTimeline, categoryCounts, filterTimeline, groupTimeline } from "../components/timeline";
import styles from "../components/timeline.module.scss";
import stylesInline from "../components/timeline.module.scss?inline";
import { LIVE_CLUSTER_PARAM, timelineUrl } from "../navigation";

import type { StoreLinkProps } from "../components/store-link";
import type { KubeEventLike, TimelineCategory, TimelineEntry } from "../components/timeline";

const { observer } = MobxReact;

const {
  Component: { Badge },
  K8sApi: { eventStore, jobStore, podsStore, pvcStore, secretsStore },
} = Renderer;

function clock(time: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

function dateAndClock(time: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** The store that can link an object of the timeline to its own panel. */
function storeOf(kind: string): StoreLinkProps["store"] {
  switch (kind) {
    case "Pod":
      return podsStore;
    case "PersistentVolumeClaim":
      return pvcStore;
    case "Job":
      return jobStore;
    case "Secret":
      return secretsStore;
    case "Cluster":
      return maybe(() => Cluster.getStore<Cluster>());
    case "Backup":
      return maybe(() => Backup.getStore<Backup>());
    case "ScheduledBackup":
      return maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
    case "Pooler":
      return maybe(() => Pooler.getStore<Pooler>());
    default:
      return undefined;
  }
}

function Entry({ entry, now }: { entry: TimelineEntry; now: Date }) {
  return (
    <div
      className={[styles.entry, styles[entry.level]].join(" ")}
      data-testid="cnpg-timeline-entry"
      data-category={entry.category}
      data-level={entry.level}
      data-future={entry.future ? "true" : "false"}
    >
      <span className={styles.time} title={entry.time.toISOString()}>
        {entry.future ? dateAndClock(entry.time) : clock(entry.time)}
      </span>
      <span>
        <Badge small className={entry.level} label={entry.category} />
      </span>
      <span className={styles.body}>
        <span className={styles.title}>
          {entry.title}
          {entry.count ? ` (x${entry.count})` : ""}
          {entry.future ? `, ${humanizeRelative(entry.time, now)}` : ""}
        </span>
        {entry.object && entry.object.kind !== "Cluster" ? (
          <span className={styles.detail}>
            {entry.object.kind}{" "}
            <StoreLink
              inline
              store={storeOf(entry.object.kind)}
              name={entry.object.name}
              namespace={entry.object.namespace}
              missing="Not there anymore"
            />
          </span>
        ) : null}
        {entry.detail ? <span className={styles.detail}>{entry.detail}</span> : null}
      </span>
    </div>
  );
}

const TimelinePanel = observer(({ cluster }: { cluster: Cluster }) => {
  const namespace = cluster.getNs() ?? "";
  const clusterStore = Cluster.getStore<Cluster>();
  const backupStore = maybe(() => Backup.getStore<Backup>());
  const scheduleStore = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
  const poolerStore = maybe(() => Pooler.getStore<Pooler>());
  const leaseStore = getLeaseStore();

  const [categories, setCategories] = React.useState<TimelineCategory[]>([]);
  const [attention, setAttention] = React.useState(false);

  useReferenceStores([
    { label: "events", store: eventStore, namespaces: [namespace] },
    { label: Backup.crd.plural, store: backupStore, namespaces: [namespace] },
    { label: ScheduledBackup.crd.plural, store: scheduleStore, namespaces: [namespace] },
    { label: Pooler.crd.plural, store: poolerStore, namespaces: [namespace] },
    { label: "pods", store: podsStore, namespaces: [namespace] },
    { label: "persistentvolumeclaims", store: pvcStore, namespaces: [namespace] },
    { label: "jobs", store: jobStore, namespaces: [namespace] },
    { label: "secrets", store: secretsStore, namespaces: [namespace] },
    { label: "leases", store: leaseStore as never, namespaces: [namespace] },
  ]);

  const now = new Date();
  const inNamespace = <T extends { getNs(): string | undefined }>(items: readonly T[]) =>
    items.filter((item) => item.getNs() === namespace);
  const entries = buildTimeline({
    cluster,
    clusters: inNamespace(clusterStore.items as Cluster[]),
    events: inNamespace(eventStore.items) as unknown as KubeEventLike[],
    backups: inNamespace((backupStore?.items ?? []) as Backup[]),
    schedules: inNamespace((scheduleStore?.items ?? []) as ScheduledBackup[]),
    poolers: inNamespace((poolerStore?.items ?? []) as Pooler[]),
    owned: [...inNamespace(podsStore.items), ...inNamespace(pvcStore.items), ...inNamespace(jobStore.items)],
    lease: leaseOfCluster(cluster, leaseStore?.items ?? []),
    now,
  });
  const visible = filterTimeline(entries, { categories, attention });
  const groups = groupTimeline(visible, now);
  const eventsForbidden = Boolean((eventStore as { failedLoading?: boolean }).failedLoading);
  const firstPast = visible.findIndex((entry) => !entry.future);

  return (
    <>
      <div className={styles.toolbar} data-testid="cnpg-timeline-toolbar">
        <span className={styles.label}>Show</span>
        {categoryCounts(entries).map(({ category, count }) => (
          <button
            key={category}
            type="button"
            className={[styles.chip, categories.length === 0 || categories.includes(category) ? styles.chipOn : ""]
              .join(" ")
              .trim()}
            aria-pressed={categories.includes(category)}
            data-testid={`cnpg-timeline-category-${category.toLowerCase()}`}
            onClick={() =>
              setCategories((current) =>
                current.includes(category) ? current.filter((item) => item !== category) : [...current, category],
              )
            }
          >
            {category} <span className={styles.count}>{count}</span>
          </button>
        ))}
        <button
          type="button"
          className={[styles.chip, attention ? styles.chipOn : ""].join(" ").trim()}
          aria-pressed={attention}
          data-testid="cnpg-timeline-attention"
          onClick={() => setAttention((value) => !value)}
        >
          Only what needs attention
        </button>
      </div>
      <div className={styles.note}>
        Kubernetes keeps events for a limited time (one hour by default): older ones are gone, while backups, the change
        of primary and the conditions stay for as long as their objects do.
        {eventsForbidden ? " The events of this namespace cannot be read with your permissions." : ""}
      </div>

      {visible.length === 0 ? (
        <div className={liveStyles.panel} data-testid="cnpg-timeline-empty">
          {entries.length === 0
            ? "Nothing to show yet: no event is left, no backup was taken and the cluster reports no timestamps."
            : "Nothing passes the filters."}
        </div>
      ) : (
        <div data-testid="cnpg-timeline-axis">
          {groups.map((group) => (
            <React.Fragment key={group.label}>
              {/* The marker sits between what is to come and the newest thing that happened, above its day. */}
              {firstPast > 0 && group.entries[0]?.id === visible[firstPast]?.id ? (
                <div className={styles.now} data-testid="cnpg-timeline-now">
                  now
                </div>
              ) : null}
              <div className={styles.group}>
                <div className={styles.day}>{group.label}</div>
                {group.entries.map((entry) => (
                  <Entry key={entry.id} entry={entry} now={now} />
                ))}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
});

export interface TimelinePageProps {
  extension: Renderer.LensExtension;
}

export const TimelinePage = observer((props: TimelinePageProps) =>
  withErrorPage(props, () => {
    const { extension } = props;

    useReferenceStores([{ label: Cluster.crd.plural, store: Cluster.getStore<Cluster>() }]);

    return (
      <ClusterPickerPage
        extension={extension}
        title="Timeline"
        testId="cnpg-timeline"
        paramName={LIVE_CLUSTER_PARAM}
        urlOf={(namespace, name) => timelineUrl(extension.name, namespace, name)}
        extraStyles={stylesInline}
      >
        {(cluster, key) => <TimelinePanel key={key} cluster={cluster} />}
      </ClusterPickerPage>
    );
  }),
);
