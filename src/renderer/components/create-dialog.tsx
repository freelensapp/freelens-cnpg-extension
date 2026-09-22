/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The form grammar every creation dialog renders identically (SPEC-0025, F2,
// F3, F7, F12): a labelled control with its messages, a section that ships
// collapsed, a key value editor, a picker over the objects a read on open
// found that always lets a name be typed, the YAML pane with its copy
// button, and the two pane message the dialog of every kind opens through
// the machinery of the action dialogs. Nothing here decides anything: the
// pure module of the kind computes every message and every fact.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { ActionFactsBlock, kubernetesClusterWords, openActionDialog } from "./action-dialog";
import styles from "./create-dialog.module.scss";
import stylesInline from "./create-dialog.module.scss?inline";

import type { ActionDialogModel, ActionDialogParams } from "./action-dialog";
import type { KeyValue } from "./create-forms";

const { observer } = MobxReact;

const {
  Component: { Input, MonacoEditor, Select },
} = Renderer;

export type ReadState = "loading" | "ready" | "unavailable";

export interface FieldProps {
  label: string;
  hint?: string;
  /** The value the API server or the operator stamps when the field is left empty (F8). */
  effective?: string;
  error?: string;
  warning?: string;
  testId?: string;
  children?: React.ReactNode;
}

/** One labelled control: what it is, what it does, why it is wrong, what it costs. */
export function Field({ label, hint, effective, error, warning, testId, children }: FieldProps) {
  return (
    <div className={styles.field} data-testid={testId}>
      <div className={styles.label}>{label}</div>
      {children}
      {hint ? <div className={styles.hint}>{hint}</div> : null}
      {effective ? <div className={styles.effective}>{`Left empty: ${effective}`}</div> : null}
      {error ? (
        <div className={styles.error} data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </div>
      ) : null}
      {warning ? (
        <div className={styles.warning} data-testid={testId ? `${testId}-warning` : undefined}>
          {warning}
        </div>
      ) : null}
    </div>
  );
}

/** A value shown as a fact, not a control: the namespace of a form opened from a cluster (F4). */
export function FactField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className={styles.field}>
      <div className={styles.label}>{label}</div>
      <div className={styles.fact} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export interface TextFieldProps extends FieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputTestId: string;
  multiLine?: boolean;
}

export function TextField({ value, onChange, placeholder, inputTestId, multiLine, ...field }: TextFieldProps) {
  return (
    <Field {...field}>
      <Input
        value={value}
        placeholder={placeholder}
        data-testid={inputTestId}
        multiLine={multiLine}
        maxRows={multiLine ? 6 : undefined}
        onChange={onChange}
      />
    </Field>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Why the option is dimmed; it stays selectable so the reason can be read next to it. */
  reason?: string;
}

export interface ChoiceFieldProps<T extends string> extends FieldProps {
  id: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
}

/** A select over a closed set of values, in the host's light theme on the white box. */
export function ChoiceField<T extends string>({
  id,
  value,
  options,
  onChange,
  placeholder,
  ...field
}: ChoiceFieldProps<T>) {
  const picked = options.find((option) => option.value === value);
  return (
    <Field {...field} hint={picked?.reason ? `${field.hint ? `${field.hint} ` : ""}${picked.reason}` : field.hint}>
      <Select
        id={id}
        themeName="light"
        menuClass={styles.selectMenu}
        placeholder={placeholder}
        value={value || null}
        options={options.map((option) => ({
          value: option.value,
          label: option.reason ? `${option.label} (${option.reason})` : option.label,
        }))}
        onChange={(option: { value: T } | null) => onChange(option?.value ?? ("" as T))}
      />
    </Field>
  );
}

const TYPED = "\u0000typed";

export interface ObjectPickerProps extends FieldProps {
  id: string;
  inputTestId: string;
  value: string;
  onChange: (value: string) => void;
  /** What the read on open found. */
  names: readonly string[];
  read: ReadState;
  /** True while the user asked to type a name instead of picking one (kept in the model, so a reopen keeps it). */
  typed: boolean;
  onTyped: (typed: boolean) => void;
  placeholder?: string;
  /** What the value is for, said when the list could not be read and the name goes unverified. */
  unverifiedHint: string;
  /** The option that means "nothing", when the field is optional. */
  noneLabel?: string;
}

/**
 * A reference to an object the form does not create (F7): a picker over what
 * the read on open found, and a text input whenever the read failed, found
 * nothing, or the user asked to type. A value the user knows is never
 * blocked by a store that is empty or forbidden.
 */
export function ObjectPicker({
  id,
  inputTestId,
  value,
  onChange,
  names,
  read,
  typed,
  onTyped,
  placeholder,
  unverifiedHint,
  noneLabel,
  ...field
}: ObjectPickerProps) {
  const pickable = read === "ready" && names.length > 0 && !typed && (value === "" || names.includes(value));
  if (!pickable) {
    const hint =
      read === "unavailable"
        ? `${field.hint ? `${field.hint} ` : ""}${unverifiedHint}`
        : read === "ready" && names.length === 0
          ? `${field.hint ? `${field.hint} ` : ""}None was found in the namespace: type the name of one that will exist.`
          : field.hint;
    return (
      <Field {...field} hint={hint}>
        <Input value={value} placeholder={placeholder} data-testid={inputTestId} onChange={onChange} />
        {read === "ready" && names.length > 0 ? (
          <button
            type="button"
            className={styles.link}
            data-testid={`${inputTestId}-pick`}
            onClick={() => {
              onTyped(false);
              if (!names.includes(value)) onChange("");
            }}
          >
            Pick from the list instead
          </button>
        ) : null}
      </Field>
    );
  }
  const options = [
    ...(noneLabel ? [{ value: "", label: noneLabel }] : []),
    ...names.map((name) => ({ value: name, label: name })),
    { value: TYPED, label: "Type a name..." },
  ];
  return (
    <Field {...field}>
      <Select
        id={id}
        themeName="light"
        menuClass={styles.selectMenu}
        placeholder={placeholder}
        value={value === "" && !noneLabel ? null : value}
        options={options}
        onChange={(option: { value: string } | null) => {
          if (option?.value === TYPED) onTyped(true);
          else onChange(option?.value ?? "");
        }}
      />
    </Field>
  );
}

export interface RadioChoice<T extends string> {
  value: T;
  label: string;
  /** One line under the option that says what it does. */
  hint?: string;
  disabledReason?: string;
}

export interface RadioFieldProps<T extends string> extends FieldProps {
  name: string;
  value: T;
  choices: readonly RadioChoice<T>[];
  onChange: (value: T) => void;
}

/**
 * A radio with one sentence per option. Native inputs rather than the host's
 * `RadioGroup`, whose radios must be its direct children and cannot carry a
 * line of their own (SPEC-0022 found the same).
 */
export function RadioField<T extends string>({ name, value, choices, onChange, ...field }: RadioFieldProps<T>) {
  return (
    <Field {...field}>
      <div
        className={styles.radios}
        role="radiogroup"
        data-testid={field.testId ? `${field.testId}-radios` : undefined}
      >
        {choices.map((choice) => (
          <div className={styles.radioLine} key={choice.value}>
            <label>
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={value === choice.value}
                disabled={Boolean(choice.disabledReason)}
                data-testid={`${name}-${choice.value}`}
                style={{ accentColor: "var(--blue)", marginRight: 8 }}
                onChange={() => onChange(choice.value)}
              />
              {choice.label}
            </label>
            {choice.hint || choice.disabledReason ? (
              <div className={styles.choiceHint}>{choice.disabledReason ?? choice.hint}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Field>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  effective?: string;
  testId: string;
  disabledReason?: string;
}

/** A native checkbox with its sentence, for the same reason as the radio above. */
export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  effective,
  testId,
  disabledReason,
}: CheckboxFieldProps) {
  return (
    <div className={styles.field}>
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={Boolean(disabledReason)}
          data-testid={testId}
          style={{ accentColor: "var(--blue)", marginRight: 8 }}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint || disabledReason ? <div className={styles.hint}>{disabledReason ?? hint}</div> : null}
      {effective ? <div className={styles.effective}>{`Unchecked: ${effective}`}</div> : null}
    </div>
  );
}

export interface CollapsibleSectionProps {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children?: React.ReactNode;
}

/** A section that ships collapsed. Controlled, so a reopen after a conflict keeps what the user opened. */
export function CollapsibleSection({ title, hint, open, onToggle, testId, children }: CollapsibleSectionProps) {
  return (
    <div className={styles.section} data-testid={testId}>
      <button
        type="button"
        className={styles.sectionHeader}
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        <span className={styles.sectionCaret}>{open ? "-" : "+"}</span>
        <span className={styles.label}>{title}</span>
      </button>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
      {open ? <div className={styles.sectionBody}>{children}</div> : null}
    </div>
  );
}

export interface KeyValueEditorProps {
  rows: readonly KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  /** The messages per row, from the pure module. */
  errors: (index: number) => { key?: string; value?: string };
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  testId: string;
}

/** Rows of a key and a value: PostgreSQL parameters, a node selector. */
export function KeyValueEditor({
  rows,
  onChange,
  errors,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  testId,
}: KeyValueEditorProps) {
  const update = (index: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className={styles.rows} data-testid={testId}>
      {rows.map((row, index) => {
        const messages = errors(index);
        return (
          <div className={styles.row} key={`${testId}-${index}`}>
            <Input
              value={row.key}
              placeholder={keyPlaceholder}
              data-testid={`${testId}-${index}-key`}
              onChange={(key: string) => update(index, { key })}
            />
            <Input
              value={row.value}
              placeholder={valuePlaceholder}
              data-testid={`${testId}-${index}-value`}
              onChange={(value: string) => update(index, { value })}
            />
            <button
              type="button"
              className={styles.button}
              data-testid={`${testId}-${index}-remove`}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              Remove
            </button>
            {messages.key || messages.value ? (
              <div className={`${styles.error} ${styles.rowMessage}`} data-testid={`${testId}-${index}-error`}>
                {messages.key ?? messages.value}
              </div>
            ) : null}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className={styles.button}
          data-testid={`${testId}-add`}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          {addLabel}
        </button>
      </div>
    </div>
  );
}

/** Two controls side by side (requests and limits, size and class). */
export function Inline({ children }: { children: React.ReactNode }) {
  return <div className={styles.inline}>{children}</div>;
}

interface YamlPaneProps {
  yaml: string;
  testId: string;
}

/** The YAML of the exact body the create sends (F12), read only, with the copy button of those who commit it instead. */
function YamlPane({ yaml, testId }: YamlPaneProps) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className={styles.yamlPane} data-testid={testId} data-yaml={yaml}>
      <div className={styles.yamlHeader}>
        <span className={styles.heading}>What will be sent</span>
        <span>
          {copied ? <span className={styles.copied}>Copied </span> : null}
          <button
            type="button"
            className={styles.button}
            data-testid={`${testId}-copy`}
            onClick={() => {
              navigator.clipboard.writeText(yaml).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            Copy YAML
          </button>
        </span>
      </div>
      <div className={styles.editor}>
        <MonacoEditor
          id={`${testId}-editor`}
          readOnly
          language="yaml"
          theme="vs"
          value={yaml}
          // The host sizes its editor from the line count of the value it mounted with (90, 180 or 360 px)
          // unless a height is given: the pane would show the first lines of a body that grew and hide the rest.
          style={{ height: "100%" }}
          options={{ scrollbar: { alwaysConsumeMouseWheel: false }, minimap: { enabled: false }, lineNumbers: "off" }}
        />
      </div>
    </div>
  );
}

export interface CreateDialogParams extends Omit<ActionDialogParams, "message" | "form"> {
  /** The fields, in reading order. */
  form: () => React.ReactNode;
  /** The YAML of the body, recomputed as the form changes. */
  yaml: () => string;
}

/**
 * The message of a creation dialog: the subject, the two panes, the reason
 * under the form, the facts. An observer, like the message of the action
 * dialogs: the facts and the YAML follow every change of the model.
 */
export const CreateDialogMessage = observer(
  ({ params, model }: { params: CreateDialogParams; model: ActionDialogModel }) => {
    const facts = params.facts();
    const cluster = kubernetesClusterWords();
    const blocked = params.blockReason?.();
    void model;
    return (
      <div className={`${styles.dialog} cnpgCreateDialog`} data-testid={params.testId}>
        <style>{stylesInline}</style>
        <p className={styles.lead}>
          {`${params.title} `}
          <b data-testid="cnpg-action-subject">{facts.subject}</b>
        </p>
        <p className={styles.context} data-testid="cnpg-action-context">
          {"Kubernetes cluster "}
          <b>{cluster.name ?? "of this window"}</b>
          {cluster.context ? ` (context ${cluster.context})` : ""}
        </p>
        {params.changedNotice ? (
          <p className={styles.warning} data-testid="cnpg-action-changed">
            {params.changedNotice}
          </p>
        ) : null}
        <div className={styles.panes}>
          <div className={styles.formPane}>
            {params.form()}
            {blocked ? (
              <p className={styles.error} data-testid="cnpg-action-blocked">
                {blocked}
              </p>
            ) : null}
            <ActionFactsBlock facts={facts} />
          </div>
          <YamlPane yaml={params.yaml()} testId={`${params.testId}-yaml`} />
        </div>
      </div>
    );
  },
);

/**
 * Opens a creation dialog: the machinery of the action dialogs (the observable
 * OK button, the reopen delay, the closing in the host's `finally`) with the
 * two pane message. `model` is passed on a reopen so the fields survive it.
 */
export function openCreateDialog(params: CreateDialogParams, model?: ActionDialogModel, delayed = false): void {
  const { form, yaml, ...rest } = params;
  openActionDialog(
    {
      ...rest,
      message: (actionParams, state) => <CreateDialogMessage params={{ ...actionParams, form, yaml }} model={state} />,
    },
    model,
    delayed,
  );
}

export { styles as createDialogStyles };
