/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Switchover" in the menu of a PostgreSQL cluster, and "Promote" on the row
// of a standby in its drawer (SPEC-0022): one merge patch on the status
// subresource, confirmed in a dialog whose body is the table of the standbys
// as they are right now. The decisions are in `components/switchover.ts`, the
// request in `api/writes/cluster-status-writes.ts`; this file reads the
// stores and the status endpoint of the primary, renders the table and
// follows W6 when the operator writes the status in between.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { createPodProxyClient, statusScheme } from "../api/instance/pod-proxy";
import { requestSwitchover } from "../api/writes/cluster-status-writes";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog, actionDialogStyles as styles } from "../components/action-dialog";
import { useReferenceStores } from "../components/reference-loader";
import {
  canSwitchover,
  lagWords,
  preselectedCandidate,
  switchoverBlockReason,
  switchoverCandidates,
  switchoverDialogFacts,
} from "../components/switchover";
import { failureSentence, firstRefusal, rfc3339Micro, writeWithConflictRetry } from "../components/write-actions";
import { timelineUrl } from "../navigation";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";

import type { AccessQuestion } from "../components/access-review";
import type { ActionDialogModel } from "../components/action-dialog";
import type {
  InstancePodFacts,
  PrimaryReplicationFacts,
  SwitchoverCandidate,
  SwitchoverClusterFacts,
} from "../components/switchover";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
  K8sApi: { podsStore },
} = Renderer;

const TITLE = "Switchover";

/** How often the candidates are read again while the dialog is open. */
export const CANDIDATES_INTERVAL_MS = 5000;

export interface ClusterSwitchoverMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function switchoverClusterFacts(object: Cluster): SwitchoverClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    resourceVersion: object.metadata?.resourceVersion,
    hibernated: Cluster.getHibernation(object),
    fenced: Cluster.getFencedInstances(object),
    spec: object.spec,
    status: object.status,
  };
}

function liveCluster(object: Cluster): Cluster {
  const store = maybe(() => Cluster.getStore<Cluster>());
  const selfLink = object.metadata?.selfLink;
  return (selfLink ? store?.getByPath(selfLink) : undefined) ?? object;
}

function access(object: Cluster): AccessQuestion[] {
  return [
    {
      verb: "patch",
      group: "postgresql.cnpg.io",
      resource: "clusters",
      subresource: "status",
      namespace: object.metadata?.namespace ?? "",
    },
  ];
}

interface PodShape {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string | undefined> };
  spec?: { nodeName?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

/** The pods of the namespace, read as plain data: eligibility asks for the labels, the node and the Ready condition. */
function instancePods(namespace: string): InstancePodFacts[] {
  return ((maybe(() => podsStore.items) ?? []) as PodShape[])
    .filter((pod) => pod.metadata?.namespace === namespace)
    .map((pod) => ({
      name: pod.metadata?.name ?? "",
      labels: pod.metadata?.labels,
      nodeName: pod.spec?.nodeName,
      ready:
        pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false,
    }));
}

/**
 * The pods of this cluster are known once the pod of its primary is in the
 * store: the store's own `isLoaded` says nothing about this namespace.
 */
function podsKnown(cluster: SwitchoverClusterFacts): boolean {
  const primary = cluster.status?.currentPrimary;
  return Boolean(primary && maybe(() => podsStore.getByName(primary, cluster.namespace)));
}

function candidatesOf(
  cluster: SwitchoverClusterFacts,
  replication: PrimaryReplicationFacts | undefined,
): SwitchoverCandidate[] {
  return switchoverCandidates(cluster, instancePods(cluster.namespace), replication);
}

/** The guard of the entry and of the row button: the candidates count only once the pods are known. */
export function switchoverGuard(object: Cluster): ActionGuard {
  const cluster = switchoverClusterFacts(object);
  return canSwitchover(cluster, podsKnown(cluster) ? candidatesOf(cluster, undefined) : undefined);
}

const proxy = createPodProxyClient();

/** What the primary reports about its standbys, or undefined when its status endpoint cannot be read. */
async function readReplication(cluster: SwitchoverClusterFacts): Promise<PrimaryReplicationFacts | undefined> {
  const primary = cluster.status?.currentPrimary;
  if (!primary) return undefined;
  const pod = maybe(() => podsStore.getByName(primary, cluster.namespace));
  const result = await proxy.getStatus(cluster.namespace, primary, statusScheme(pod as never));
  if (!result.ok) return undefined;
  return { currentLsn: result.value.currentLsn, rows: result.value.replicationInfo ?? [] };
}

interface SwitchoverModel {
  target: string | undefined;
  replication: PrimaryReplicationFacts | undefined;
}

interface TableProps {
  object: Cluster;
  model: SwitchoverModel;
}

const CandidatesTable = observer(({ object, model }: TableProps) => {
  const cluster = switchoverClusterFacts(liveCluster(object));
  const candidates = candidatesOf(cluster, model.replication);

  return (
    <div className={styles.field}>
      <span className={styles.label}>The standby to promote</span>
      <table className={styles.candidates} data-testid="cnpg-switchover-candidates">
        <thead>
          <tr>
            <th />
            <th>Instance</th>
            <th>State</th>
            <th>Sync</th>
            <th>Replay lag</th>
            <th>Node</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => {
            const chosen = candidate.name === model.target;
            const classes = [
              styles.candidate,
              chosen ? styles.chosen : "",
              candidate.eligible ? "" : styles.ineligible,
            ];
            const choose = () => {
              if (!candidate.eligible) return;
              Mobx.runInAction(() => {
                model.target = candidate.name;
              });
            };

            return (
              <tr
                key={candidate.name}
                className={classes.filter(Boolean).join(" ")}
                onClick={choose}
                title={candidate.reason}
                data-testid={`cnpg-switchover-candidate-${candidate.name}`}
                data-eligible={candidate.eligible ? "true" : "false"}
              >
                <td>
                  <input
                    type="radio"
                    name="cnpg-switchover-target"
                    aria-label={`Promote ${candidate.name}`}
                    checked={chosen}
                    disabled={!candidate.eligible}
                    onChange={choose}
                  />
                </td>
                <td>
                  <b>{candidate.name}</b>
                  {candidate.reason ? <span className={styles.reason}>{candidate.reason}</span> : null}
                </td>
                <td>{candidate.state ?? (model.replication ? "not reported" : "not readable")}</td>
                <td>{candidate.syncState ?? "N/A"}</td>
                <td data-testid={`cnpg-switchover-lag-${candidate.name}`}>{lagWords(candidate, model.replication)}</td>
                <td>{candidate.nodeName ?? "N/A"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span className={styles.hint}>
        {model.replication
          ? `Read from the primary ${cluster.status?.currentPrimary ?? ""} every ${CANDIDATES_INTERVAL_MS / 1000} s. The lag informs the choice, it does not gate it.`
          : "The status endpoint of the primary cannot be read, so the lag is unknown. The switchover stays available."}
      </span>
    </div>
  );
});

interface OpenOptions {
  /** From "Promote" on a row: that standby is the one proposed. */
  preselected?: string;
  model?: SwitchoverModel;
  dialog?: ActionDialogModel;
  changedNotice?: string;
}

export async function openSwitchover(
  object: Cluster,
  extension: Renderer.LensExtension,
  { preselected, model, dialog, changedNotice }: OpenOptions = {},
): Promise<void> {
  const opened = switchoverClusterFacts(object);

  // The pods first, so eligibility is decided on facts; then one read of the
  // primary, so the proposed standby is the one with the least lag.
  await maybe(() =>
    podsStore.loadAll({ namespaces: [opened.namespace], merge: true, onLoadFailure: () => undefined }),
  )?.catch(() => undefined);

  const state: SwitchoverModel = model ?? Mobx.observable({ target: undefined, replication: undefined });
  const first = await readReplication(opened);

  Mobx.runInAction(() => {
    state.replication = first;
    if (!state.target) {
      const candidates = candidatesOf(opened, first);
      const asked = candidates.find((candidate) => candidate.name === preselected && candidate.eligible)?.name;
      state.target = asked ?? preselectedCandidate(candidates);
    }
  });

  const timer = setInterval(() => {
    readReplication(switchoverClusterFacts(liveCluster(object)))
      .then((replication) => {
        Mobx.runInAction(() => {
          state.replication = replication;
        });
      })
      .catch(() => undefined);
  }, CANDIDATES_INTERVAL_MS);

  const current = () => {
    const cluster = switchoverClusterFacts(liveCluster(object));
    return { cluster, candidates: candidatesOf(cluster, state.replication) };
  };

  const run = async () => {
    const target = state.target;
    if (!target) return;
    const atConfirm = current();
    const confirmed = switchoverDialogFacts(atConfirm.cluster, atConfirm.candidates, target).writes;

    const outcome = await writeWithConflictRetry({
      confirmed,
      send: () => {
        const { cluster } = current();
        return requestSwitchover(
          { namespace: cluster.namespace, name: cluster.name, resourceVersion: cluster.resourceVersion ?? "" },
          target,
          rfc3339Micro(new Date()),
        );
      },
      refresh: async () => {
        await maybe(() => Cluster.getStore<Cluster>())?.load({ name: opened.name, namespace: opened.namespace });
        const { cluster, candidates } = current();
        const blocked = switchoverBlockReason(candidates, target);
        return {
          guard: firstRefusal(
            canSwitchover(cluster, candidates),
            blocked ? { enabled: false, reason: blocked } : undefined,
          ),
          writes: switchoverDialogFacts(cluster, candidates, target).writes,
        };
      },
    });

    switch (outcome.kind) {
      case "written":
        Notifications.ok(
          <p data-testid="cnpg-switchover-requested">
            {`Switchover of ${opened.namespace}/${opened.name} to `}
            <b>{target}</b>
            {" requested. The operator does the rest: follow it in the "}
            <MaybeLink to={timelineUrl(extension.name, opened.namespace, opened.name)}>Timeline</MaybeLink>
            {" of the cluster."}
          </p>,
        );
        return;
      case "changed":
        // The user never confirms one write and sends another: the dialog comes back with the new facts.
        void openSwitchover(liveCluster(object), extension, {
          model: state,
          dialog,
          changedNotice: "The cluster changed while the write was sent: nothing was written. Read the write again.",
        });
        return;
      case "refused":
        Notifications.error(
          `Switchover of ${opened.namespace}/${opened.name} not requested: the cluster changed in the meantime. ${outcome.reason}.`,
        );
        return;
      case "failed":
        if (!outcome.failure.alreadyNotified) {
          Notifications.error(
            `Could not request the switchover of ${opened.namespace}/${opened.name}. ${failureSentence(
              outcome.failure,
              { verb: "patch", resource: "clusters/status", namespace: opened.namespace },
            )}`,
          );
        }
    }
  };

  openActionDialog(
    {
      title: TITLE,
      testId: "cnpg-switchover-dialog",
      accent: true,
      facts: () => {
        const { cluster, candidates } = current();
        return switchoverDialogFacts(cluster, candidates, state.target);
      },
      form: () => <CandidatesTable object={object} model={state} />,
      blockReason: () => {
        const { cluster, candidates } = current();
        return canSwitchover(cluster, candidates).reason ?? switchoverBlockReason(candidates, state.target);
      },
      changedNotice,
      run,
      onClose: () => clearInterval(timer),
    },
    dialog,
    Boolean(changedNotice),
  );
}

function SwitchoverMenuItem({ object, toolbar, extension }: ClusterSwitchoverMenuItemProps) {
  // The list of the clusters does not load the pods by itself, and the guard counts the standbys that can be promoted.
  useReferenceStores([{ label: "pods", store: podsStore, namespaces: [object.metadata?.namespace ?? ""] }]);

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title={TITLE}
      icon="swap_horiz"
      testId="cnpg-cluster-switchover-menu-item"
      access={access}
      guard={switchoverGuard}
      live={liveCluster}
      open={(cluster) => openSwitchover(cluster, extension)}
    />
  );
}

export function ClusterSwitchoverMenuItem(props: ClusterSwitchoverMenuItemProps) {
  if (!props.object || props.object.kind !== Cluster.kind) return null;
  return <SwitchoverMenuItem {...props} />;
}

export interface PromoteButtonProps {
  cluster: Cluster;
  instanceName: string;
  extension: Renderer.LensExtension;
}

/** "Promote" on the row of a standby in the Instances table of the drawer: the same dialog, with that row chosen. */
export const PromoteButton = observer(({ cluster, instanceName, extension }: PromoteButtonProps) => {
  const live = liveCluster(cluster);
  const facts = switchoverClusterFacts(live);
  const row = podsKnown(facts)
    ? candidatesOf(facts, undefined).find((candidate) => candidate.name === instanceName)
    : undefined;
  const accessVerdict = useAccessGuard(access(cluster));
  const verdictOf = (object: Cluster): ActionGuard =>
    firstRefusal(
      switchoverGuard(object),
      row && !row.eligible ? { enabled: false, reason: row.reason ?? "It cannot be promoted" } : undefined,
      accessVerdict,
    );
  const verdict = verdictOf(live);
  const tooltip = verdict.enabled ? `Promote ${instanceName}` : `Promote ${instanceName}: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid={`cnpg-instance-promote-${instanceName}`}
      onClick={(event) => {
        event.stopPropagation();
        // The guard again on the click, against the object as the store holds it now (W2).
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        void openSwitchover(liveCluster(cluster), extension, { preselected: instanceName });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material="upgrade" tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
