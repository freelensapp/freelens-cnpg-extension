/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The psql controls (SPEC-0007): the "Open psql" entry of a Cluster's menu and
// the per instance button of the drawer and of the live view. Both go through
// `openPsql`, which re-evaluates the guard on the live object, composes the
// command with the pure module and hands it to the host's terminal. It is not
// a write action of the extension (DESIGN.md section 13): no API call, no
// confirmation, a tooltip that says in plain words what the session is.

import { Common, Renderer } from "@freelensapp/extensions";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { instanceFacts } from "../components/cluster-health";
import { canOpenPsql, psqlCommand, psqlTabId, psqlTabTitle, psqlTarget, psqlTooltip } from "../components/psql";

import type { PsqlClusterFacts } from "../components/psql";

const {
  Component: { createTerminalTab, Icon, MenuItem, Notifications, terminalStore },
} = Renderer;

export function psqlClusterFacts(cluster: Cluster): PsqlClusterFacts {
  return {
    name: cluster.metadata?.name ?? "",
    namespace: cluster.metadata?.namespace ?? "",
    hibernated: Cluster.getHibernation(cluster),
    currentPrimary: cluster.status?.currentPrimary || undefined,
    instances: instanceFacts(cluster).map((instance) => ({
      name: instance.name,
      role: instance.role,
      fenced: instance.fenced,
    })),
  };
}

/** The object of the moment: the menu and the drawer hold a copy the watch may have replaced since. */
function liveCluster(cluster: Cluster): Cluster {
  const store = maybe(() => Cluster.getStore<Cluster>());
  const name = cluster.metadata?.name;
  return (name ? store?.getByName(name, cluster.metadata?.namespace) : undefined) ?? cluster;
}

export async function openPsql(cluster: Cluster, instanceName?: string): Promise<void> {
  const facts = psqlClusterFacts(liveCluster(cluster));
  const target = psqlTarget(facts, instanceName);
  // `disabled` on a host control is styling: the guard is what stops the click.
  if (!target || !canOpenPsql(facts, target).enabled) return;

  // The only failure that is the extension's own: the tab or the send. What
  // comes after (a missing pods/exec, a pod that went away) is kubectl's own
  // words on the user's own terminal.
  try {
    const tabId = psqlTabId(target);
    createTerminalTab({ title: psqlTabTitle(target), id: tabId });
    await terminalStore.sendCommand(psqlCommand(target, Common.App.Preferences.getKubectlPath()), {
      enter: true,
      tabId,
    });
  } catch (error) {
    Notifications.checkedError(error, `Could not open psql on ${target.namespace}/${target.pod}.`);
  }
}

export interface ClusterPsqlMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
}

export function ClusterPsqlMenuItem({ object, toolbar }: ClusterPsqlMenuItemProps) {
  // The host hands the menu a plain copy of the object (AGENTS.md): guard on the kind.
  if (!object || object.kind !== Cluster.kind) return null;

  const facts = psqlClusterFacts(object);
  const target = psqlTarget(facts);
  const guard = canOpenPsql(facts, target);
  const tooltip = psqlTooltip(target, guard);

  return (
    <MenuItem
      onClick={() => void openPsql(object)}
      disabled={!guard.enabled}
      title={tooltip}
      data-testid="cnpg-cluster-psql-menu-item"
    >
      <Icon material="terminal" interactive={toolbar} tooltip={tooltip} />
      <span className="title">Open psql</span>
    </MenuItem>
  );
}

export interface PsqlButtonProps {
  cluster: Cluster;
  instanceName: string;
}

/** The psql control of one instance: a small icon, or the reason it cannot be offered. */
export function PsqlButton({ cluster, instanceName }: PsqlButtonProps) {
  const facts = psqlClusterFacts(cluster);
  const target = psqlTarget(facts, instanceName);
  const guard = canOpenPsql(facts, target);
  const tooltip = psqlTooltip(target, guard);

  return (
    <Icon
      small
      material="terminal"
      interactive={guard.enabled}
      disabled={!guard.enabled}
      tooltip={tooltip}
      data-testid={`cnpg-psql-${instanceName}`}
      onClick={(event) => {
        event.stopPropagation();
        void openPsql(cluster, instanceName);
      }}
    />
  );
}
