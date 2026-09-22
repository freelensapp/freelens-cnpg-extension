/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the four creation dialogs of SPEC-0027 share on top of the machinery
// of `create-dialog.tsx`: the namespace and cluster fields (a fact when the
// form was opened from a cluster), the reclaim policy radio, the rows of a
// `WITH` clause, the one `create` with its notification and its reopen on a
// refusal, and the reads of the clusters of the namespace.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import { Cluster } from "../api/cnpg/cluster-v1";
import { FactField, Field, KeyValueEditor, RadioField, createDialogStyles as styles } from "./create-dialog";
import { ObjectChoiceField } from "./create-pickers";
import { clusterStateReason } from "./declarative-create";
import { declarativeClusterFacts } from "./declarative-facts";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { ReadState } from "./create-dialog";
import type { KeyValue } from "./create-forms";
import type { ReclaimChoice } from "./declarative-create";
import type { DeclarativeClusterFacts } from "./declarative-facts";

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  Navigation: { getDetailsUrl },
} = Renderer;

/** Every read the dialogs make: what it found, or `unavailable` when it failed. Nothing blocks on it. */
export async function readInto<T, Inputs extends { reads: Record<string, ReadState> }>(
  model: { inputs: Inputs },
  key: keyof Inputs["reads"] & string,
  fetchItems: () => Promise<T[] | null | undefined>,
  fold: (items: T[]) => Partial<Inputs>,
): Promise<void> {
  const set = (patch: Partial<Inputs>, state: ReadState) => {
    Mobx.runInAction(() => {
      model.inputs = { ...model.inputs, ...patch, reads: { ...model.inputs.reads, [key]: state } };
    });
  };
  set({}, "loading");
  try {
    const items = (await fetchItems()) ?? [];
    set(fold(items), "ready");
  } catch {
    set({}, "unavailable");
  }
}

/** The clusters of the namespace, as the declarative forms need them. */
export function listClusterFacts(namespace: string): Promise<DeclarativeClusterFacts[]> {
  return Cluster.getStore<Cluster>()
    .api.list({ namespace })
    .then((items) => (items ?? []).map(declarativeClusterFacts));
}

export interface NamespaceAndClusterProps {
  testId: string;
  namespace: string;
  cluster: string;
  fixedNamespace?: string;
  fixedCluster?: string;
  clusters: readonly DeclarativeClusterFacts[];
  clustersRead: ReadState;
  typing: boolean;
  onTyping: (typing: boolean) => void;
  onNamespace: (namespace: string) => void;
  onCluster: (cluster: string) => void;
  errors: Record<string, string>;
  warnings: Record<string, string>;
}

/** The namespace and the cluster of every declarative form (F4, F1). */
export function NamespaceAndClusterFields({
  testId,
  namespace,
  cluster,
  fixedNamespace,
  fixedCluster,
  clusters,
  clustersRead,
  typing,
  onTyping,
  onNamespace,
  onCluster,
  errors,
  warnings,
}: NamespaceAndClusterProps) {
  return (
    <>
      {fixedNamespace ? (
        <FactField label="Namespace" value={fixedNamespace} testId={`${testId}-namespace-fact`} />
      ) : (
        <Field label="Namespace" error={errors.namespace} testId={`${testId}-namespace`}>
          <NamespaceSelect
            id={`${testId}-namespace-select`}
            themeName="light"
            menuClass={styles.selectMenu}
            value={namespace || null}
            onChange={(option: { value: string } | null) => onNamespace(option?.value ?? "")}
          />
        </Field>
      )}
      {fixedCluster ? (
        <FactField label="Cluster" value={fixedCluster} testId={`${testId}-cluster-fact`} />
      ) : (
        <ObjectChoiceField
          id={`${testId}-cluster`}
          testId={`${testId}-cluster`}
          label="Cluster"
          value={cluster}
          onChange={onCluster}
          choices={clusters.map((choice) => ({ name: choice.name, reason: clusterStateReason(choice) }))}
          read={clustersRead}
          typed={typing}
          onTyped={onTyping}
          placeholder="Pick a cluster"
          hint="Its primary applies the object."
          unverifiedHint="The clusters could not be listed: the name goes unverified."
          error={errors.cluster}
          warning={warnings.cluster}
        />
      )}
    </>
  );
}

export function ReclaimField({
  testId,
  kind,
  what,
  value,
  onChange,
}: {
  testId: string;
  kind: string;
  what: string;
  value: ReclaimChoice;
  onChange: (value: ReclaimChoice) => void;
}) {
  return (
    <RadioField
      label="When the object is deleted"
      name={`${testId}-reclaim`}
      value={value}
      onChange={onChange}
      testId={`${testId}-reclaim`}
      choices={[
        {
          value: "retain",
          label: "Keep the " + what,
          hint: `The ${kind} object goes, the ${what} stays in PostgreSQL.`,
        },
        { value: "delete", label: "Drop the " + what, hint: `The ${what} is dropped in PostgreSQL with the object.` },
      ]}
    />
  );
}

export function ParametersField({
  testId,
  rows,
  onChange,
  errors,
  known,
  hint,
}: {
  testId: string;
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  errors: Record<string, string>;
  known: readonly string[];
  hint: string;
}) {
  return (
    <Field
      label="Parameters (WITH clause)"
      hint={`${hint} PostgreSQL knows: ${known.join(", ")}.`}
      testId={`${testId}-parameters-field`}
    >
      <KeyValueEditor
        rows={rows}
        onChange={onChange}
        errors={(index) => ({ key: errors[`parameters.${index}.key`], value: errors[`parameters.${index}.value`] })}
        keyPlaceholder={known[0]}
        valuePlaceholder="value"
        addLabel="Add a parameter"
        testId={`${testId}-parameters`}
      />
    </Field>
  );
}

export interface CreateRunOptions {
  kind: string;
  resource: string;
  namespace: string;
  name: string;
  body: Record<string, unknown>;
  create: () => Promise<{ selfLink?: string } | undefined | null>;
  successMessage: string;
  reload: () => void;
  reopen: (notice: string) => void;
}

/** The one `create` of a declarative form (F9): the notification with its door, or the reopen with the refusal at the top (F6). */
export async function runCreate({
  kind,
  resource,
  namespace,
  name,
  create,
  successMessage,
  reload,
  reopen,
}: CreateRunOptions): Promise<void> {
  try {
    const created = await create();
    const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
    Notifications.ok(
      <span>
        {successMessage}
        {url ? (
          <>
            {" "}
            <MaybeLink to={url}>Open it</MaybeLink>
          </>
        ) : null}
      </span>,
    );
  } catch (error) {
    const failure = apiFailureFacts(error);
    const notice = isAlreadyExists(failure)
      ? `A ${kind} object named ${name} appeared in ${namespace} in the meantime: pick another name.`
      : failureSentence(failure, { verb: "create", resource, namespace });
    reload();
    reopen(notice);
  }
}
