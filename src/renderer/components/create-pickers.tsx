/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Two pickers the forms of SPEC-0026 and SPEC-0027 share on top of the grammar
// of `create-dialog.tsx`: an object of the extension's own kinds with a reason
// per choice (a hibernated cluster, a cluster with one instance), and a key
// inside a secret. Both always let a name be typed (F7).

import { Renderer } from "@freelensapp/extensions";
import { ChoiceField, Field, createDialogStyles as styles, TextField } from "./create-dialog";

import type { ReadState } from "./create-dialog";

const {
  Component: { Input, Select },
} = Renderer;

const TYPED = "\u0000typed";

export interface PickerChoice {
  name: string;
  /** What the option says, when more than the name helps (a snapshot with its backup and day); the value stays the name. */
  label?: string;
  /** Why the choice is dimmed; it stays selectable so the reason can be read next to it. */
  reason?: string;
}

export interface ObjectChoiceFieldProps {
  id: string;
  testId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: readonly PickerChoice[];
  read: ReadState;
  typed: boolean;
  onTyped: (typed: boolean) => void;
  placeholder: string;
  /** What the value is for, said when the list could not be read and the name goes unverified. */
  unverifiedHint: string;
  hint?: string;
  error?: string;
  warning?: string;
}

/** A picker over the objects a read found, each with its reason, degrading to a text input; "Type a name..." always offered. */
export function ObjectChoiceField({
  id,
  testId,
  label,
  value,
  onChange,
  choices,
  read,
  typed,
  onTyped,
  placeholder,
  unverifiedHint,
  hint,
  error,
  warning,
}: ObjectChoiceFieldProps) {
  const names = choices.map((choice) => choice.name);
  const pickable = read === "ready" && names.length > 0 && !typed && (value === "" || names.includes(value));
  if (!pickable) {
    const degradedHint =
      read === "unavailable"
        ? `${hint ? `${hint} ` : ""}${unverifiedHint}`
        : read === "ready" && names.length === 0
          ? `${hint ? `${hint} ` : ""}None was found in the namespace: type the name of one that will exist.`
          : hint;
    return (
      <Field label={label} hint={degradedHint} error={error} warning={warning} testId={`${testId}-field`}>
        <Input value={value} placeholder={placeholder} data-testid={testId} onChange={onChange} />
        {read === "ready" && names.length > 0 ? (
          <button
            type="button"
            className={styles.link}
            data-testid={`${testId}-pick`}
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
  return (
    <ChoiceField
      id={id}
      label={label}
      value={value}
      placeholder={placeholder}
      options={[
        ...choices.map((choice) => ({ value: choice.name, label: choice.label ?? choice.name, reason: choice.reason })),
        { value: TYPED, label: "Type a name..." },
      ]}
      onChange={(picked) => {
        if (picked === TYPED) onTyped(true);
        else onChange(picked);
      }}
      hint={hint}
      error={error}
      warning={warning}
      testId={`${testId}-field`}
    />
  );
}

export interface SecretKeyChoice {
  name: string;
  keys: string[];
}

export interface SecretKeyFieldProps {
  testId: string;
  label: string;
  /** The name of the secret and the key inside it, as typed. */
  value: { name: string; key: string };
  onChange: (value: { name: string; key: string }) => void;
  secrets: readonly SecretKeyChoice[];
  read: ReadState;
  typed: boolean;
  onTyped: (typed: boolean) => void;
  hint?: string;
  error?: string;
  warning?: string;
}

/** A key inside a secret: the secret as a picker (or typed), the key as a picker over the keys the secret carries (or typed). */
export function SecretKeyField({
  testId,
  label,
  value,
  onChange,
  secrets,
  read,
  typed,
  onTyped,
  hint,
  error,
  warning,
}: SecretKeyFieldProps) {
  const names = secrets.map((secret) => secret.name);
  const picked = secrets.find((secret) => secret.name === value.name);
  const keys = picked?.keys ?? [];
  const keyPickable = keys.length > 0 && (value.key === "" || keys.includes(value.key));
  return (
    <Field label={label} hint={hint} error={error} warning={warning} testId={`${testId}-field`}>
      <div className={styles.inline}>
        <ObjectChoiceField
          id={`${testId}-secret`}
          testId={`${testId}-secret`}
          label="Secret"
          value={value.name}
          onChange={(name) => onChange({ name, key: value.key })}
          choices={names.map((name) => ({ name }))}
          read={read}
          typed={typed}
          onTyped={onTyped}
          placeholder="Pick a secret"
          unverifiedHint="The secrets could not be listed: the name goes unverified."
        />
        {keyPickable ? (
          <Field label="Key">
            <Select
              id={`${testId}-key`}
              themeName="light"
              menuClass={styles.selectMenu}
              placeholder="Pick a key"
              value={value.key || null}
              options={keys.map((key) => ({ value: key, label: key }))}
              onChange={(option: { value: string } | null) => onChange({ name: value.name, key: option?.value ?? "" })}
            />
          </Field>
        ) : (
          <TextField
            label="Key"
            value={value.key}
            onChange={(key) => onChange({ name: value.name, key })}
            placeholder="The key inside the secret"
            inputTestId={`${testId}-key`}
          />
        )}
      </div>
    </Field>
  );
}
