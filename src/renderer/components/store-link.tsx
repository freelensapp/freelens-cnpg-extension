/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// A reference to another object rendered as a link to its drawer when the
// object is in its store, else as plain text (DESIGN.md section 3: a
// reference is linked only when the target is actually there). The link goes
// through the host details URL, which works for core kinds and for the
// extension's own kinds alike, and never fights the row selection.

import { Renderer } from "@freelensapp/extensions";

const {
  Component: { MaybeLink, WithTooltip },
  Navigation: { getDetailsUrl },
} = Renderer;

interface LinkableObject {
  selfLink: string;
}

interface LinkableStore {
  getByName(name: string, namespace?: string): LinkableObject | undefined;
}

export interface StoreLinkProps {
  store: LinkableStore | null | undefined;
  name: string | undefined;
  namespace?: string;
  /** Tooltip of the plain text shown when the object is not in the store. */
  missing?: string;
  /** Text shown when there is no name at all. */
  empty?: string;
}

export function StoreLink({ store, name, namespace, missing, empty = "N/A" }: StoreLinkProps) {
  if (!name) return <>{empty}</>;
  const object = store?.getByName(name, namespace);
  if (!object) return <WithTooltip tooltip={missing}>{name}</WithTooltip>;
  return (
    <MaybeLink to={getDetailsUrl(object.selfLink)} onClick={(event) => event.stopPropagation()}>
      <WithTooltip>{name}</WithTooltip>
    </MaybeLink>
  );
}
