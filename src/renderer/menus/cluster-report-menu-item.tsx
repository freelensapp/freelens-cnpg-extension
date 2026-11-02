/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Save diagnostic report" in the menu of a PostgreSQL cluster (SPEC-0038).
// The renderer collects the objects of the cluster from the API server, the
// status of each instance from its instance manager and, when asked, the last
// lines of their logs, as the views do; `components/report.ts` cleans and lays
// them out; main asks where to save and writes the archive
// (`main/report-save.ts`). Reads only; no Secret is read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { Database } from "../api/cnpg/database-v1";
import { FailoverQuorum } from "../api/cnpg/failover-quorum-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { createPodLogsClient } from "../api/instance/pod-logs";
import { createPodProxyClient, statusScheme } from "../api/instance/pod-proxy";
import { kubernetesClusterWords, openActionDialog } from "../components/action-dialog";
import { CheckboxField, TextField } from "../components/create-dialog";
import { belongsTo, CLUSTER_LABEL, reportFileName, reportFiles } from "../components/report";
import { subjectOf } from "../components/write-actions";
import { cnpgIpc } from "../ipc";
import { ActionIcon } from "./action-icon";
import { liveCluster } from "./cluster-live";

import type { ReportFolder, ReportInput, ReportObject } from "../components/report";
import type { ActionDialogFacts } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MenuItem, Notifications },
  K8sApi: { eventApi, jobApi, pdbApi, podsApi, pvcApi, serviceApi },
} = Renderer;

export const DEFAULT_LOG_LINES = 500;
const MAX_LOG_LINES = 10_000;

interface Listable {
  list(options: { namespace: string }, query?: { labelSelector?: string }): Promise<unknown[] | null>;
}

interface PlainLike {
  toPlainObject?: () => Record<string, unknown>;
}

function plain(item: unknown): ReportObject {
  const like = item as PlainLike;
  return (typeof like?.toPlainObject === "function" ? like.toPlainObject() : item) as ReportObject;
}

function apiOf(read: () => { api: unknown }): Listable | undefined {
  try {
    return read().api as Listable;
  } catch {
    return undefined;
  }
}

/** Where each folder is listed from: by the cluster's label when the objects carry it, else the namespace. */
function sources(): Array<{ folder: ReportFolder; api: Listable | undefined; labelled: boolean }> {
  return [
    { folder: "pods", api: podsApi as unknown as Listable, labelled: true },
    { folder: "jobs", api: jobApi as unknown as Listable, labelled: true },
    { folder: "pvcs", api: pvcApi as unknown as Listable, labelled: true },
    { folder: "services", api: serviceApi as unknown as Listable, labelled: true },
    { folder: "pdbs", api: pdbApi as unknown as Listable, labelled: true },
    { folder: "backups", api: apiOf(() => Backup.getStore<Backup>()), labelled: false },
    { folder: "scheduledbackups", api: apiOf(() => ScheduledBackup.getStore<ScheduledBackup>()), labelled: false },
    { folder: "poolers", api: apiOf(() => Pooler.getStore<Pooler>()), labelled: false },
    { folder: "databases", api: apiOf(() => Database.getStore<Database>()), labelled: false },
    { folder: "roles", api: apiOf(() => DatabaseRole.getStore<DatabaseRole>()), labelled: false },
    { folder: "publications", api: apiOf(() => Publication.getStore<Publication>()), labelled: false },
    { folder: "subscriptions", api: apiOf(() => Subscription.getStore<Subscription>()), labelled: false },
    { folder: "failoverquorums", api: apiOf(() => FailoverQuorum.getStore<FailoverQuorum>()), labelled: false },
    { folder: "objectstores", api: apiOf(() => ObjectStore.getStore<ObjectStore>()), labelled: false },
  ];
}

async function collect(object: Cluster, logLines: number | undefined): Promise<ReportInput> {
  const cluster = plain(object);
  const namespace = object.getNs() ?? "";
  const name = object.getName();
  const unreadable: string[] = [];
  const objects: ReportInput["objects"] = {};

  await Promise.all(
    sources().map(async ({ folder, api, labelled }) => {
      if (!api) {
        unreadable.push(`${folder}: the kind is not installed`);
        return;
      }
      try {
        const items = await api.list({ namespace }, labelled ? { labelSelector: `${CLUSTER_LABEL}=${name}` } : {});
        objects[folder] = (items ?? []).map(plain).filter((item) => belongsTo(folder, item, cluster));
      } catch {
        unreadable.push(`${folder}: could not be listed`);
      }
    }),
  );

  let events: ReportObject[] = [];
  try {
    events = ((await (eventApi as unknown as Listable).list({ namespace })) ?? []).map(plain);
  } catch {
    unreadable.push("events: could not be listed");
  }

  const pods = objects.pods ?? [];
  const instances = (object.status?.instanceNames ?? []).filter(Boolean);
  const proxy = createPodProxyClient();
  const statuses = await Promise.all(
    instances.map(async (instance) => {
      const pod = pods.find((candidate) => candidate.metadata?.name === instance);
      const result = await proxy.getStatus(
        namespace,
        instance,
        statusScheme(pod as Parameters<typeof statusScheme>[0]),
      );
      return result.ok
        ? { instance, status: result.value }
        : { instance, error: `the instance manager did not answer (${result.failure.kind})` };
    }),
  );

  let logs: ReportInput["logs"];
  if (logLines) {
    const client = createPodLogsClient();
    logs = await Promise.all(
      instances.map(async (pod) => {
        const result = await client.getLogs({ namespace, pod, container: "postgres", tailLines: logLines });
        return result.ok
          ? { pod, text: result.value }
          : { pod, error: `the logs could not be read (${result.failure.kind})` };
      }),
    );
  }

  return {
    cluster,
    objects,
    events,
    statuses,
    logs,
    logLines,
    unreadable: unreadable.sort(),
    generatedAt: new Date(),
    context: kubernetesClusterWords().context,
  };
}

function reportFacts(object: Cluster, logLines: number | undefined): ActionDialogFacts {
  const namespace = object.getNs() ?? "";
  const name = object.getName();
  return {
    subject: subjectOf("Cluster", namespace, name),
    writes: [],
    notes: [
      "Nothing is written to the Kubernetes cluster: the report only reads.",
      "In the archive: the Cluster; its pods, jobs, volumes, services and disruption budgets; its backups, schedules, poolers, databases, roles, publications, subscriptions, failover quorum and the object stores it refers to; the events about them; the status of each instance.",
      logLines
        ? `With the last ${logLines} lines of the logs of the postgres container of each instance.`
        : "Without the logs of the instances.",
      "No Secret is read; managedFields are removed; values under keys named like a password, a token or a key read <redacted>.",
      `One file, ${reportFileName(namespace, name, new Date()).replace(/\d{8}-\d{6}/, "<time>")}, where you choose in the next dialog.`,
    ],
    warnings: logLines
      ? [
          "Logs may hold what the applications wrote into them (queries, user names): read them before you share the file.",
        ]
      : [],
  };
}

export function openReport(object: Cluster): void {
  const options = Mobx.observable({ logs: false, lines: String(DEFAULT_LOG_LINES) });
  const lines = () => {
    const value = Number(options.lines);
    return Number.isInteger(value) && value >= 1 && value <= MAX_LOG_LINES ? value : undefined;
  };

  const Options = observer(() => (
    <>
      <CheckboxField
        label="Include the logs of the instances"
        checked={options.logs}
        onChange={(value) =>
          Mobx.runInAction(() => {
            options.logs = value;
          })
        }
        testId="cnpg-report-logs"
      />
      {options.logs ? (
        <TextField
          label="Lines per instance"
          value={options.lines}
          onChange={(value) =>
            Mobx.runInAction(() => {
              options.lines = value;
            })
          }
          inputTestId="cnpg-report-lines"
          testId="cnpg-report-lines-field"
          error={lines() ? undefined : `A whole number from 1 to ${MAX_LOG_LINES}`}
        />
      ) : null}
    </>
  ));

  const run = async () => {
    const live = liveCluster(object);
    const ipc = cnpgIpc();
    if (!ipc) {
      Notifications.error("The extension cannot reach its main process: reload Freelens.");
      return;
    }
    const logLines = options.logs ? lines() : undefined;
    const input = await collect(live, logLines);
    const namespace = live.getNs() ?? "";
    const name = live.getName();
    const answer = await ipc.saveReport({
      suggestedName: reportFileName(namespace, name, input.generatedAt),
      title: `Save the diagnostic report of ${namespace}/${name}`,
      files: reportFiles(input),
    });
    if (answer?.path) {
      Notifications.ok(
        <p data-testid="cnpg-report-saved">{`Diagnostic report of ${namespace}/${name} saved to ${answer.path}.`}</p>,
      );
    } else if (answer?.error) {
      Notifications.error(`The diagnostic report of ${namespace}/${name} was not saved: ${answer.error}.`);
    }
  };

  openActionDialog({
    title: "Save diagnostic report",
    testId: "cnpg-report-dialog",
    facts: () => reportFacts(liveCluster(object), options.logs ? lines() : undefined),
    form: () => <Options />,
    blockReason: () => (options.logs && !lines() ? `A whole number from 1 to ${MAX_LOG_LINES} lines` : undefined),
    run,
  });
}

export interface ClusterReportMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
}

/** Reads only, so no access review of a write: what cannot be read is said in the README of the archive. */
export function ClusterReportMenuItem({ object, toolbar }: ClusterReportMenuItemProps) {
  if (!object || object.kind !== Cluster.kind) return null;
  return (
    <MenuItem onClick={() => openReport(liveCluster(object))} data-testid="cnpg-cluster-report-menu-item">
      <ActionIcon material="summarize" toolbar={toolbar} tooltip="Save diagnostic report" disabled={false} />
      <span className="title">Save diagnostic report</span>
    </MenuItem>
  );
}
