/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Destroy" on the row of a replica in the Instances table of the cluster
// drawer (SPEC-0037), the most destructive action of the extension. The
// decisions are in `components/destroy-instance.ts`; this file reads the
// volumes, the pod, the jobs and the running backups of the instance from the
// API server, and sends the writes of `kubectl cnpg destroy` one by one, in
// its order, after the instance name is typed. No "keep the volumes": see
// `components/destroy-instance.ts`.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog } from "../components/action-dialog";
import {
  canDestroyInstance,
  destroyFacts,
  destroyPlan,
  destroyWrites,
  INSTANCE_NAME_LABEL,
} from "../components/destroy-instance";
import { apiFailureFacts, failureSentence, firstRefusal, sameWrites } from "../components/write-actions";
import { timelineUrl } from "../navigation";
import { ActionIcon } from "./action-icon";
import { liveCluster } from "./cluster-live";

import type { AccessQuestion } from "../components/access-review";
import type {
  DestroyClaim,
  DestroyClusterFacts,
  DestroyPlan,
  DestroyPod,
  OwnerReference,
  RunningBackup,
} from "../components/destroy-instance";
import type { ActionGuard, ActionWrite } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
  K8sApi: { jobApi, podsApi, pvcApi },
} = Renderer;

const RUNNING_BACKUP_PHASES = ["started", "running", "finalizing"];

export function destroyClusterFacts(object: Cluster): DestroyClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    status: {
      currentPrimary: object.status?.currentPrimary,
      targetPrimary: object.status?.targetPrimary,
      instanceNames: object.status?.instanceNames,
    },
  };
}

function access(object: Cluster): AccessQuestion[] {
  const namespace = object.metadata?.namespace ?? "";
  return [
    { verb: "delete", group: "", resource: "persistentvolumeclaims", namespace },
    { verb: "delete", group: "", resource: "pods", namespace },
    { verb: "delete", group: "batch", resource: "jobs", namespace },
  ];
}

interface MetaShape {
  metadata?: {
    name?: string;
    labels?: Record<string, string | undefined>;
    annotations?: Record<string, string | undefined>;
    ownerReferences?: OwnerReference[];
  };
  spec?: { resources?: { requests?: { storage?: string } } };
}

/** What the destroy reads about an instance, from the API server rather than the stores: they may not hold it all. */
interface DestroyReads {
  claims: DestroyClaim[];
  pod?: DestroyPod;
  jobs: string[];
  backups: RunningBackup[];
}

async function readInstance(namespace: string, cluster: string, instance: string): Promise<DestroyReads> {
  const selector = { labelSelector: `${INSTANCE_NAME_LABEL}=${instance}` };
  const [claims, pods, jobs, backups] = await Promise.all([
    pvcApi.list({ namespace }, selector) as Promise<MetaShape[] | null>,
    podsApi.list({ namespace }, { fieldSelector: `metadata.name=${instance}` }) as Promise<MetaShape[] | null>,
    jobApi.list({ namespace }, selector) as Promise<MetaShape[] | null>,
    Backup.getStore<Backup>().api.list({ namespace }) as Promise<Backup[] | null>,
  ]);
  const pod = (pods ?? [])[0];
  return {
    claims: (claims ?? []).map((claim) => ({
      name: claim.metadata?.name ?? "",
      labels: claim.metadata?.labels ?? {},
      annotations: claim.metadata?.annotations ?? {},
      ownerReferences: claim.metadata?.ownerReferences ?? [],
      size: claim.spec?.resources?.requests?.storage,
    })),
    pod: pod
      ? { name: pod.metadata?.name ?? instance, ownerReferences: pod.metadata?.ownerReferences ?? [] }
      : undefined,
    jobs: (jobs ?? []).map((job) => job.metadata?.name ?? "").filter(Boolean),
    backups: (backups ?? [])
      .filter(
        (backup) =>
          Backup.getClusterName(backup) === cluster && RUNNING_BACKUP_PHASES.includes(Backup.getPhase(backup) ?? ""),
      )
      .map((backup) => ({ name: backup.getName(), instance: Backup.getInstancePod(backup) })),
  };
}

function planOf(cluster: DestroyClusterFacts, instance: string, reads: DestroyReads): DestroyPlan {
  return destroyPlan(cluster.name, instance, reads.claims, reads.pod, reads.jobs);
}

/** Sends the writes one by one; stops at the first failure and says which were sent. */
async function sendWrites(
  cluster: DestroyClusterFacts,
  plan: DestroyPlan,
): Promise<{ sent: ActionWrite[]; failed?: { write: ActionWrite; error: unknown } }> {
  const namespace = cluster.namespace;
  const writes = destroyWrites(cluster, plan);
  const steps: Array<() => Promise<unknown>> = [
    ...plan.claims.map((claim) => () => pvcApi.delete({ name: claim.name, namespace })),
    ...(plan.pod ? [() => podsApi.delete({ name: plan.pod ?? "", namespace })] : []),
    ...plan.jobs.map((job) => () => jobApi.delete({ name: job, namespace, propagationPolicy: "Background" })),
  ];
  const sent: ActionWrite[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      await step();
    } catch (error) {
      return { sent, failed: { write: writes[index], error } };
    }
    sent.push(writes[index]);
  }
  return { sent };
}

export async function openDestroyInstance(
  object: Cluster,
  instance: string,
  extension: Renderer.LensExtension,
): Promise<void> {
  const opened = destroyClusterFacts(object);
  const state = Mobx.observable(
    { reads: { claims: [], jobs: [], backups: [] } as DestroyReads },
    { reads: Mobx.observableRef },
  );

  const reads = await readInstance(opened.namespace, opened.name, instance);
  Mobx.runInAction(() => {
    state.reads = reads;
  });

  const blockReason = (): string | undefined => {
    const cluster = destroyClusterFacts(liveCluster(object));
    const guard = canDestroyInstance(cluster, instance, state.reads.backups);
    if (!guard.enabled) return guard.reason;
    return planOf(cluster, instance, state.reads).podRefusal;
  };

  const run = async () => {
    const confirmed = destroyWrites(opened, planOf(opened, instance, state.reads));
    // W2 and W6: everything is read again right before the writes; a plan that changed is not sent.
    const cluster = destroyClusterFacts(liveCluster(object));
    let fresh: DestroyReads;
    try {
      fresh = await readInstance(cluster.namespace, cluster.name, instance);
    } catch (error) {
      Notifications.error(
        `Destroy of ${instance} not requested: the instance could not be read again. ${failureSentence(
          apiFailureFacts(error),
          {
            verb: "delete",
            resource: "pods",
            namespace: cluster.namespace,
          },
        )} Nothing was written.`,
      );
      return;
    }
    const guard = canDestroyInstance(cluster, instance, fresh.backups);
    const plan = planOf(cluster, instance, fresh);
    if (!guard.enabled || plan.podRefusal || !sameWrites(confirmed, destroyWrites(cluster, plan))) {
      Notifications.error(
        `Destroy of ${instance} not requested: the instance changed in the meantime${
          guard.reason || plan.podRefusal ? `. ${guard.reason ?? plan.podRefusal}` : ""
        }. Nothing was written.`,
      );
      return;
    }
    const outcome = await sendWrites(cluster, plan);
    if (outcome.failed) {
      const failure = apiFailureFacts(outcome.failed.error);
      const done = outcome.sent.map((write) => write.text).join("; ");
      Notifications.error(
        `Destroy of ${instance} stopped at "${outcome.failed.write.text}". ${failureSentence(failure, {
          verb: outcome.failed.write.verb,
          resource: outcome.failed.write.text.split(" ")[1]?.toLowerCase() ?? "objects",
          namespace: cluster.namespace,
        })} ${done ? `Already done: ${done}.` : "Nothing was written."}`,
      );
      return;
    }
    Notifications.ok(
      <p data-testid="cnpg-destroy-instance-requested">
        {`${instance} of ${cluster.namespace}/${cluster.name} destroyed. The operator now creates the instance again from the primary: follow it in the `}
        <MaybeLink to={timelineUrl(extension.name, cluster.namespace, cluster.name)}>Timeline</MaybeLink>
        {" of the cluster."}
      </p>,
    );
  };

  openActionDialog({
    title: "Destroy instance",
    testId: "cnpg-destroy-instance-dialog",
    accent: true,
    facts: () =>
      destroyFacts(destroyClusterFacts(liveCluster(object)), instance, planOf(opened, instance, state.reads)),
    blockReason,
    run,
  });
}

function guardOf(object: Cluster, instance: string): ActionGuard {
  return canDestroyInstance(destroyClusterFacts(object), instance);
}

export interface DestroyInstanceButtonProps {
  cluster: Cluster;
  instanceName: string;
  extension: Renderer.LensExtension;
}

/** "Destroy" on the row of a replica (W1); the row of the primary has none. */
export const DestroyInstanceButton = observer(({ cluster, instanceName, extension }: DestroyInstanceButtonProps) => {
  const live = liveCluster(cluster);
  const accessVerdict = useAccessGuard(access(live));
  const verdictOf = (object: Cluster): ActionGuard => firstRefusal(guardOf(object, instanceName), accessVerdict);
  const verdict = verdictOf(live);
  const verb = `Destroy ${instanceName}: the operator recreates it from the primary`;
  const tooltip = verdict.enabled ? verb : `Destroy ${instanceName}: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid={`cnpg-instance-destroy-${instanceName}`}
      onClick={(event) => {
        event.stopPropagation();
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        openDestroyInstance(liveCluster(cluster), instanceName, extension).catch((error) =>
          Notifications.checkedError(error, `Could not prepare the destroy of ${instanceName}.`),
        );
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material="delete_forever" tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
