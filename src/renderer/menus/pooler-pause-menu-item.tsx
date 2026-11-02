/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Pause" or "Resume" in the menu of a pooler, and on the "Pause" row of its
// drawer (SPEC-0037). The decisions are in `components/pooler-pause.ts`; the
// dialog of the pause reads the clients connected right now from the PgBouncer
// exporter of the pooler's pods (SPEC-0012) and sends one merge patch.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { maybe } from "../../common/utils";
import { POOLER_NAME_LABEL, Pooler } from "../api/cnpg/pooler-v1";
import { createPodProxyClient, poolerMetricsScheme } from "../api/instance/pod-proxy";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog, actionDialogStyles as styles } from "../components/action-dialog";
import { buildPoolerView } from "../components/live/pooler-model";
import { PoolerPoller } from "../components/live/pooler-poller";
import {
  canPausePooler,
  canResumePooler,
  connectedClientsWords,
  pausePoolerFacts,
  poolerPausePatch,
  resumePoolerFacts,
} from "../components/pooler-pause";
import { apiFailureFacts, failureSentence, firstRefusal } from "../components/write-actions";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";

import type { AccessQuestion } from "../components/access-review";
import type { PoolerPauseFacts } from "../components/pooler-pause";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { Notifications },
  K8sApi: { podsApi },
} = Renderer;

type PauseAction = "pause" | "resume";

export function livePooler(object: Pooler): Pooler {
  const store = maybe(() => Pooler.getStore<Pooler>());
  const selfLink = object.metadata?.selfLink;
  return (selfLink ? store?.getByPath(selfLink) : undefined) ?? object;
}

export function poolerPauseFacts(object: Pooler): PoolerPauseFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    cluster: object.spec?.cluster?.name,
    paused: object.spec?.pgbouncer?.paused === true,
    phase: object.status?.phase,
  };
}

function access(object: Pooler): AccessQuestion[] {
  return [
    { verb: "patch", group: "postgresql.cnpg.io", resource: "poolers", namespace: object.metadata?.namespace ?? "" },
  ];
}

function guardOf(object: Pooler, action: PauseAction): ActionGuard {
  const pooler = poolerPauseFacts(object);
  return action === "pause" ? canPausePooler(pooler) : canResumePooler(pooler);
}

/** The clients connected through the pooler while the dialog is open, from the exporter of its pods. */
const ClientsNow = observer(({ pooler }: { pooler: Pooler }) => {
  const [pods, setPods] = React.useState<string[] | undefined>(undefined);
  const namespace = pooler.getNs() ?? "";
  const name = pooler.getName();

  React.useEffect(() => {
    let current = true;
    void podsApi.list({ namespace }, { labelSelector: `${POOLER_NAME_LABEL}=${name}` }).then(
      (items) => current && setPods((items ?? []).map((pod) => pod.getName())),
      () => current && setPods([]),
    );
    return () => {
      current = false;
    };
  }, [namespace, name]);

  const poller = React.useMemo(
    () =>
      pods && pods.length > 0
        ? new PoolerPoller({
            client: createPodProxyClient(),
            targets: () => pods.map((pod) => ({ namespace, pod, scheme: poolerMetricsScheme(pooler) })),
          })
        : undefined,
    [pods, namespace, pooler],
  );

  React.useEffect(() => {
    poller?.start();
    return () => poller?.stop();
  }, [poller]);

  const view = poller ? buildPoolerView(poller.samples) : undefined;
  const words =
    pods && pods.length === 0
      ? "The pooler has no pod right now: no client is connected through it."
      : poller?.answered && !view
        ? "The clients connected right now could not be read from the pooler's pods."
        : connectedClientsWords(view?.clients);

  return (
    <p className={styles.hint} data-testid="cnpg-pooler-pause-clients">
      {words}
    </p>
  );
});

export async function openPoolerPause(object: Pooler, action: PauseAction): Promise<void> {
  const opened = poolerPauseFacts(object);
  const pausing = action === "pause";

  const run = async () => {
    const store = maybe(() => Pooler.getStore<Pooler>());
    if (!store) {
      Notifications.error(`Could not ${action} ${opened.namespace}/${opened.name}: the poolers are not available.`);
      return;
    }
    try {
      await store.patch(livePooler(object), poolerPausePatch(pausing), "merge");
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not ${action} ${opened.namespace}/${opened.name}. ${failureSentence(failure, {
            verb: "patch",
            resource: "poolers",
            namespace: opened.namespace,
          })}`,
        );
      }
      return;
    }
    Notifications.ok(
      <p data-testid={pausing ? "cnpg-pooler-pause-requested" : "cnpg-pooler-resume-requested"}>
        {pausing
          ? `Pause of the pooler ${opened.namespace}/${opened.name} requested: its state shows when PgBouncer is paused.`
          : `Resume of the pooler ${opened.namespace}/${opened.name} requested: PgBouncer sends the queries it held.`}
      </p>,
    );
  };

  openActionDialog({
    title: pausing ? "Pause pooler" : "Resume pooler",
    testId: pausing ? "cnpg-pooler-pause-dialog" : "cnpg-pooler-resume-dialog",
    accent: pausing,
    facts: () => {
      const pooler = poolerPauseFacts(livePooler(object));
      return pausing ? pausePoolerFacts(pooler) : resumePoolerFacts(pooler);
    },
    form: pausing ? () => <ClientsNow pooler={livePooler(object)} /> : undefined,
    blockReason: () => guardOf(livePooler(object), action).reason,
    run,
  });
}

export interface PoolerPauseMenuItemProps {
  object: Pooler;
  toolbar?: boolean;
}

/** Exactly one of the two, by `spec.pgbouncer.paused` as the store holds it. */
export const PoolerPauseMenuItem = observer(({ object, toolbar }: PoolerPauseMenuItemProps) => {
  if (!object || object.kind !== Pooler.kind) return null;

  const action: PauseAction = poolerPauseFacts(livePooler(object)).paused ? "resume" : "pause";

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Pooler.kind}
      title={action === "pause" ? "Pause" : "Resume"}
      icon={action === "pause" ? "pause_circle" : "play_circle"}
      testId={action === "pause" ? "cnpg-pooler-pause-menu-item" : "cnpg-pooler-resume-menu-item"}
      access={access}
      guard={(pooler) => guardOf(pooler, action)}
      live={livePooler}
      open={(pooler) => openPoolerPause(pooler, action)}
    />
  );
});

/** The control on the "Pause" row of the drawer: next to the state it changes (W1). */
export const PoolerPauseButton = observer(({ pooler }: { pooler: Pooler }) => {
  const live = livePooler(pooler);
  const action: PauseAction = poolerPauseFacts(live).paused ? "resume" : "pause";
  const accessVerdict = useAccessGuard(access(live));
  const verdictOf = (object: Pooler): ActionGuard => firstRefusal(guardOf(object, action), accessVerdict);
  const verdict = verdictOf(live);
  const title = action === "pause" ? "Pause" : "Resume";
  const tooltip = verdict.enabled ? title : `${title}: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid={`cnpg-pooler-${action}-button`}
      onClick={(event) => {
        event.stopPropagation();
        if (!verdictOf(livePooler(pooler)).enabled) return;
        void openPoolerPause(livePooler(pooler), action);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon
        material={action === "pause" ? "pause_circle" : "play_circle"}
        tooltip={tooltip}
        disabled={!verdict.enabled}
        toolbar
      />
    </span>
  );
});
