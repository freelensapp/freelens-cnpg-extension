/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The confirmation dialog of every write action (SPEC-0020, W4, W5, W8): the
// object and the Kubernetes cluster it lives in, one numbered line per API
// call, what the write means, what it costs, and, for the actions that ask for
// it, the name of the cluster typed by the user before OK is enabled.
//
// Three facts of the host (Freelens 1.10.3) shape this file:
//
// - `ConfirmDialog.open({ ok })` keeps the dialog on screen with its OK button
//   in the `waiting` state until the promise of `ok` settles, and then always
//   closes it. That is "no second submit while a write is in flight" for free.
// - The OK button reacts to nothing except an `okButtonProps` that is itself a
//   MobX observable: a plain object is read once per render of the host and
//   nothing renders the host again.
// - Reopening a dialog remounts its message, so everything a reopen must keep
//   (the typed name, the values of a form) lives in a MobX model outside React.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import React from "react";
import { maybe } from "../../common/utils";
import styles from "./action-dialog.module.scss";
import stylesInline from "./action-dialog.module.scss?inline";
import { DIALOG_REOPEN_DELAY_MS, typedNameMatches } from "./write-actions";

import type { ActionDialogFacts } from "./write-actions";

const { observer } = MobxReact;

const {
  Component: { ConfirmDialog, Icon, Input },
} = Renderer;

/** The Kubernetes cluster the frame belongs to, as Freelens names it, with its kubeconfig context. */
export interface KubernetesClusterWords {
  name?: string;
  context?: string;
}

export function kubernetesClusterWords(): KubernetesClusterWords {
  const active = maybe(() => Renderer.Catalog.getActiveCluster());
  return { name: active?.name, context: active?.contextName };
}

export interface ActionDialogModel {
  typed: string;
  okButtonProps: { disabled: boolean; primary: boolean; accent: boolean };
}

export interface ActionDialogParams {
  /** The verb: the lead of the message and the label of OK. */
  title: string;
  testId: string;
  /** The host's accent styling, for an action that interrupts something. */
  accent?: boolean;
  /** Read inside an observer: a form that changes observables changes the facts. */
  facts: () => ActionDialogFacts;
  /** The fields of the action, between the subject and the writes. */
  form?: () => React.ReactNode;
  /** Why OK is disabled beyond the typed name, shown under the form. */
  blockReason?: () => string | undefined;
  /** True while OK must stay disabled for a reason a field of the form already shows. */
  okBlocked?: () => boolean;
  /** Set on a reopen after a conflict whose facts changed (W6). */
  changedNotice?: string;
  /** Performs the writes and reports the outcome. Owns its own failures (W9). */
  run: () => Promise<void>;
  /** Called once when the dialog goes away, confirmed or not: where an action stops what it started on open. */
  onClose?: () => void;
  /** A message of its own (the creation forms of SPEC-0025), over the same model and machinery. */
  message?: (params: ActionDialogParams, model: ActionDialogModel) => React.ReactNode;
}

interface MessageProps {
  params: ActionDialogParams;
  model: ActionDialogModel;
}

const ActionDialogMessage = observer(({ params, model }: MessageProps) => {
  const body = React.useRef<HTMLDivElement>(null);

  // The typed name takes the focus as it mounts, and the browser scrolls a long
  // dialog down to it: the user would start reading a dangerous action from its
  // last line. The dialog opens at its first one.
  React.useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, []);

  const facts = params.facts();
  const cluster = kubernetesClusterWords();
  const blocked = params.blockReason?.();

  return (
    <div className={styles.dialog} data-testid={params.testId} ref={body}>
      <style>{stylesInline}</style>
      <p className={styles.lead}>
        {`${params.title} `}
        <b data-testid="cnpg-action-subject">{facts.subject}</b>?
      </p>
      <p className={styles.context} data-testid="cnpg-action-context">
        {"Kubernetes cluster "}
        <b>{cluster.name ?? "of this window"}</b>
        {cluster.context ? ` (context ${cluster.context})` : ""}
      </p>
      {params.changedNotice ? (
        <p className={styles.changed} data-testid="cnpg-action-changed">
          {params.changedNotice}
        </p>
      ) : null}
      {params.form?.()}
      {blocked ? (
        <p className={styles.error} data-testid="cnpg-action-blocked">
          {blocked}
        </p>
      ) : null}
      <ActionFactsBlock facts={facts} />
      {facts.typedName ? (
        <div className={styles.field}>
          <span className={styles.label}>
            {"Type "}
            <b>{facts.typedName}</b>
            {" to confirm"}
          </span>
          <Input
            autoFocus
            value={model.typed}
            placeholder={facts.typedName}
            data-testid="cnpg-action-typed-name"
            onChange={(value: string) => {
              Mobx.runInAction(() => {
                model.typed = value;
              });
            }}
          />
        </div>
      ) : null}
    </div>
  );
});

/** The writes in order, what they mean and what they cost (W4): the block every dialog of the extension ends with. */
export function ActionFactsBlock({ facts }: { facts: ActionDialogFacts }) {
  return (
    <>
      <div className={styles.heading}>{facts.writes.length === 1 ? "The one write" : "The writes, in order"}</div>
      <ol
        className={facts.writes.length === 1 ? `${styles.writes} ${styles.single}` : styles.writes}
        data-testid="cnpg-action-writes"
      >
        {facts.writes.map((write) => (
          <li key={write.text}>
            <code>{write.text}</code>
          </li>
        ))}
      </ol>
      {facts.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {facts.warnings.map((warning) => (
        <p key={warning} className={styles.warning} data-testid="cnpg-action-warning">
          <Icon small material="warning" />
          <span>{warning}</span>
        </p>
      ))}
    </>
  );
}

function isBlocked(params: ActionDialogParams): boolean {
  return Boolean(params.blockReason?.()) || Boolean(params.okBlocked?.());
}

export function createActionDialogModel(accent: boolean): ActionDialogModel {
  return Mobx.observable({ typed: "", okButtonProps: { disabled: false, primary: !accent, accent } });
}

/**
 * Opens the dialog. `model` is passed on a reopen so that what the user typed
 * survives it; `delayed` waits out the leave window of the host's animation.
 */
export function openActionDialog(params: ActionDialogParams, model?: ActionDialogModel, delayed = false): void {
  const state = model ?? createActionDialogModel(Boolean(params.accent));

  const open = () => {
    const stopSync = Mobx.autorun(() => {
      const facts = params.facts();
      const disabled = !typedNameMatches(state.typed, facts.typedName) || isBlocked(params);
      Mobx.runInAction(() => {
        state.okButtonProps.disabled = disabled;
      });
    });

    ConfirmDialog.open({
      labelOk: params.title,
      // No icon: the host's default is a warning triangle on every dialog, which
      // says nothing. What is dangerous says so in the warning lines.
      icon: null,
      okButtonProps: state.okButtonProps,
      message: params.message ? params.message(params, state) : <ActionDialogMessage params={params} model={state} />,
      ok: async () => {
        stopSync();
        try {
          // The disabled OK button is what stops the click; this is the same
          // check on the write path itself, so nothing is ever sent unconfirmed.
          if (!typedNameMatches(state.typed, params.facts().typedName) || isBlocked(params)) {
            return;
          }
          await params.run();
        } finally {
          params.onClose?.();
        }
      },
      cancel: () => {
        stopSync();
        params.onClose?.();
      },
    });
  };

  if (delayed) {
    setTimeout(open, DIALOG_REOPEN_DELAY_MS);
  } else {
    open();
  }
}

export { styles as actionDialogStyles };
