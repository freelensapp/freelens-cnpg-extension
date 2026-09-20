/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The shell every write action of a menu is built on (SPEC-0020, W1 to W3):
// the host idiom of a `kubeObjectMenuItems` component, the guard at render,
// the guard again on the click against the object as the store holds it at
// that moment, and the hand-over to the action's own dialog.
//
// Two facts of the host shape it:
//
// - One registration renders in both surfaces: the row menu of the list and,
//   with `toolbar`, the title bar of the drawer, where the label is hidden and
//   the tooltip of the icon is what carries the words.
// - `disabled` on a `MenuItem` does not stop its `onClick`: it adds a class,
//   and what stops the pointer is the stylesheet. A guard that lives only in
//   CSS is not a guard on a write surface, so the click handler runs it again.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { useAccessGuard } from "../components/access-review";
import { firstRefusal } from "../components/write-actions";
import { ActionIcon } from "./action-icon";

import type { AccessQuestion } from "../components/access-review";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MenuItem, Notifications },
} = Renderer;

/** The slice of a kube object the shell itself reads. */
export interface ActionObject {
  kind?: string;
  metadata?: { name?: string; namespace?: string; deletionTimestamp?: string; selfLink?: string };
}

export interface ActionMenuItemProps<T extends ActionObject> {
  object: T;
  toolbar?: boolean;
  /** The kind the item is registered for: the host hands the menu a plain copy of the object. */
  kind: string;
  /** The verb: the label of the item and the start of its tooltip. */
  title: string;
  /** A host Material ligature. */
  icon: string;
  testId: string;
  /** What the user must be allowed to do (W3). */
  access: (object: T) => AccessQuestion[];
  /** The pure guard of the action (W2). */
  guard: (object: T) => ActionGuard;
  /** The object as the store holds it right now, or the one the row was rendered with. */
  live: (object: T) => T;
  /** Opens the dialog of the action, from the live object. */
  open: (object: T) => void | Promise<void>;
}

function ActionMenuItemInner<T extends ActionObject>(props: ActionMenuItemProps<T>) {
  const { object, toolbar, title, icon, testId, access, guard, live, open } = props;
  const accessVerdict = useAccessGuard(access(object));
  const verdict = firstRefusal(guard(object), accessVerdict);
  const tooltip = verdict.enabled ? title : `${title}: ${verdict.reason}`;

  const onClick = async () => {
    const current = live(object);
    if (!firstRefusal(guard(current), accessVerdict).enabled) return;
    try {
      await open(current);
    } catch (error) {
      Notifications.checkedError(error, `Could not prepare "${title}" for ${object.metadata?.name ?? "the object"}.`);
    }
  };

  return (
    <MenuItem onClick={onClick} disabled={!verdict.enabled} data-testid={testId} title={tooltip}>
      <ActionIcon material={icon} toolbar={toolbar} tooltip={tooltip} disabled={!verdict.enabled} />
      <span className="title">{title}</span>
    </MenuItem>
  );
}

const ObservedActionMenuItem = observer(ActionMenuItemInner) as typeof ActionMenuItemInner;

/** Renders nothing for another kind and for an object that is being deleted (W2). */
export function ActionMenuItem<T extends ActionObject>(props: ActionMenuItemProps<T>) {
  const { object, kind } = props;
  if (!object || object.kind !== kind || object.metadata?.deletionTimestamp) return null;
  return <ObservedActionMenuItem {...props} />;
}
