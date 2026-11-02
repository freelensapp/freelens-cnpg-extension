/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The sections SPEC-0034 adds to the drawer of a cluster: its volumes as one
// table, the jobs of the operator while any exists, and what a replica cluster
// replicates. Thin shells over `cluster-resources.ts`.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { humanizeDuration } from "../components/backup-health";
import { jobRows, replicaClusterFacts, storageRows, volumeRoleWords } from "../components/cluster-resources";
import styles from "./cluster-details.module.scss";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { JobRow, JobShape, PvcShape, VolumeState } from "../components/cluster-resources";

const { observer } = MobxReact;

const {
  Component: {
    Badge,
    DrawerItem,
    DrawerTitle,
    Icon,
    LinkToJob,
    MaybeLink,
    Table,
    TableCell,
    TableHead,
    TableRow,
    WithTooltip,
    logTabStore,
  },
  K8sApi: { jobStore, podsStore, pvcStore },
  Navigation: { getDetailsUrl },
} = Renderer;

const VOLUME_STATE_CLASS: Record<VolumeState, string> = {
  healthy: "success",
  resizing: "warning",
  initializing: "info",
  dangling: "error",
  unusable: "error",
  unknown: "info",
};

const VOLUME_STATE_WORDS: Record<VolumeState, string> = {
  healthy: "In use by its instance",
  resizing: "Being resized: the operator waits for the storage to report the new size",
  initializing: "Being prepared for a new instance",
  dangling: "Its instance is gone: the operator may reattach it to a new instance of the same name",
  unusable: "The operator cannot use it, it needs a look",
  unknown: "Not in the lists of the cluster's status",
};

/** The volumes of the cluster (SPEC-0034): replaces the lists by state of SPEC-0003, the state is a column. */
export const StorageTable = observer(({ cluster }: { cluster: Cluster }) => {
  const namespace = cluster.getNs() ?? "";
  const rows = storageRows(cluster, pvcStore.items as unknown as PvcShape[]);
  if (rows.length === 0) return null;
  // The host's Table does not pass a test id on: the wrapper carries it.
  return (
    <div data-testid="cnpg-cluster-volumes">
      <Table scrollable={false} sortSyncWithUrl={false} className={styles.volumes}>
        <TableHead flat sticky={false}>
          <TableCell className={styles.name}>Volume</TableCell>
          <TableCell className={styles.instance}>Instance</TableCell>
          <TableCell className={styles.role}>Role</TableCell>
          <TableCell className={styles.state}>State</TableCell>
          <TableCell className={styles.size}>Size</TableCell>
          <TableCell className={styles.storageClass}>Storage class</TableCell>
        </TableHead>
        {rows.map((row) => {
          const claim = row.known ? pvcStore.getByName(row.name, namespace) : undefined;
          const size =
            row.capacity && row.requested && row.capacity !== row.requested
              ? `${row.capacity} of ${row.requested} requested`
              : (row.capacity ?? row.requested ?? "N/A");
          return (
            <TableRow key={row.name} nowrap data-testid={`cnpg-cluster-volume-${row.name}`}>
              <TableCell className={styles.name}>
                {claim ? (
                  <MaybeLink to={getDetailsUrl(claim.selfLink)} onClick={(event) => event.stopPropagation()}>
                    {row.name}
                  </MaybeLink>
                ) : (
                  <WithTooltip tooltip="The claim is not in the cluster (or not loaded yet)">{row.name}</WithTooltip>
                )}
              </TableCell>
              <TableCell className={styles.instance}>
                <WithTooltip>{row.instance ?? "N/A"}</WithTooltip>
              </TableCell>
              <TableCell className={styles.role}>
                <WithTooltip>{volumeRoleWords(row)}</WithTooltip>
              </TableCell>
              <TableCell className={styles.state}>
                <Badge
                  className={VOLUME_STATE_CLASS[row.state]}
                  label={row.state}
                  tooltip={VOLUME_STATE_WORDS[row.state]}
                />
              </TableCell>
              <TableCell className={styles.size}>
                <WithTooltip>{size}</WithTooltip>
              </TableCell>
              <TableCell className={styles.storageClass}>
                <WithTooltip>{row.storageClass ?? "N/A"}</WithTooltip>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
    </div>
  );
});

const JOB_STATE_CLASS: Record<JobRow["state"], string> = {
  running: "info",
  succeeded: "success",
  failed: "error",
  pending: "info",
};

/** Opens the logs of the job's pod in the host's log viewer: a job is not an instance, so not the Logs page. */
function openJobLogs(namespace: string, job: string): void {
  const pod = podsStore.items.find((item) => item.getNs() === namespace && item.metadata?.labels?.["job-name"] === job);
  const container = pod?.spec?.containers?.[0];
  if (pod && container) logTabStore.createPodTab({ selectedPod: pod, selectedContainer: container });
}

/** The jobs of the operator for this cluster (SPEC-0034), only while any exists: it removes them once done. */
export const JobsSection = observer(({ cluster }: { cluster: Cluster }) => {
  const namespace = cluster.getNs() ?? "";
  const rows = jobRows(cluster, jobStore.items as unknown as JobShape[]);
  if (rows.length === 0) return null;
  return (
    <>
      <DrawerTitle>Jobs</DrawerTitle>
      <div data-testid="cnpg-cluster-jobs">
        <Table scrollable={false} sortSyncWithUrl={false} className={styles.jobs}>
          <TableHead flat sticky={false}>
            <TableCell className={styles.name}>Job</TableCell>
            <TableCell className={styles.reason}>What it does</TableCell>
            <TableCell className={styles.instance}>Instance</TableCell>
            <TableCell className={styles.state}>Status</TableCell>
            <TableCell className={styles.size}>Started</TableCell>
            <TableCell className={styles.logs}>Logs</TableCell>
          </TableHead>
          {rows.map((row) => {
            const hasPod = podsStore.items.some(
              (item) => item.getNs() === namespace && item.metadata?.labels?.["job-name"] === row.name,
            );
            return (
              <TableRow key={row.name} nowrap data-testid={`cnpg-cluster-job-${row.name}`} data-role={row.role}>
                <TableCell className={styles.name}>
                  <LinkToJob name={row.name} namespace={namespace} />
                </TableCell>
                <TableCell className={styles.reason}>
                  <WithTooltip>{row.roleWords}</WithTooltip>
                </TableCell>
                <TableCell className={styles.instance}>
                  <WithTooltip>{row.instance ?? "N/A"}</WithTooltip>
                </TableCell>
                <TableCell className={styles.state}>
                  <Badge className={JOB_STATE_CLASS[row.state]} label={row.state} tooltip={row.message} />
                </TableCell>
                <TableCell className={styles.size}>
                  {row.startedAt ? (
                    <WithTooltip tooltip={row.startedAt.toISOString()}>
                      {row.durationMs !== undefined
                        ? `${row.state === "running" ? "for" : "took"} ${humanizeDuration(row.durationMs)}`
                        : "N/A"}
                    </WithTooltip>
                  ) : (
                    "not yet"
                  )}
                </TableCell>
                <TableCell className={styles.logs}>
                  {hasPod ? (
                    <Icon
                      small
                      material="subject"
                      tooltip="The logs of its pod, in the log viewer of Freelens"
                      data-testid={`cnpg-cluster-job-logs-${row.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openJobLogs(namespace, row.name);
                      }}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      </div>
    </>
  );
});

/** What a replica cluster replicates and how it would be promoted (SPEC-0034); nothing for a primary cluster. */
export function ReplicaClusterSection({ cluster }: { cluster: Cluster }) {
  const facts = replicaClusterFacts(cluster);
  if (!facts) return null;
  return (
    <>
      <DrawerTitle>Replica cluster</DrawerTitle>
      <div data-testid="cnpg-cluster-replica">
        <DrawerItem name="Replicates">
          <WithTooltip tooltip="spec.replica.source: the external cluster this cluster follows">
            {facts.source ?? "N/A"}
            {facts.sourceWords ? `, ${facts.sourceWords}` : ""}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Designated primary" hidden={!facts.designatedPrimary}>
          <WithTooltip tooltip="The instance that replicates from the source and feeds the others; it stays in recovery until the cluster is promoted">
            {facts.designatedPrimary}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Distributed topology" hidden={!facts.distributed}>
          <WithTooltip tooltip="spec.replica.primary and spec.replica.self: the cluster of the group that is the primary, and this one">
            {`the primary of the group is ${facts.groupPrimary}, this cluster is ${facts.self}`}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Minimum apply delay" hidden={!facts.minApplyDelay}>
          <WithTooltip tooltip="The standby applies a change only this long after the source committed it: time to stop a mistake from replicating">
            {facts.minApplyDelay}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Promotion token" hidden={!facts.promotionToken}>
          <WithTooltip tooltip="Set by whoever promotes this cluster: the demotion token of the former primary cluster, so that no WAL is lost">
            {facts.promotionToken}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Demotion token" hidden={!facts.demotionToken}>
          <WithTooltip tooltip="Written by the operator when this cluster was demoted: the promotion token of the cluster that takes over">
            {facts.demotionToken}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Promotion">
          <WithTooltip tooltip="A write this extension does not offer (SPEC-0034 scope)">
            {facts.distributed
              ? "Change spec.replica.primary to this cluster, with the demotion token of the former primary as promotion token"
              : "Set spec.replica.enabled to false: the designated primary leaves recovery and the cluster accepts writes"}
          </WithTooltip>
        </DrawerItem>
      </div>
    </>
  );
}
