/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The first section of the drawers of the declarative kinds (SPEC-0013): the
// condition, the sentence that explains it, the generations, and the rival
// objects when two of them target the same thing in PostgreSQL.

import { Renderer } from "@freelensapp/extensions";
import { generationWords } from "./declarative";
import { StoreLink } from "./store-link";

import type { DeclarativeHealth, DeclarativeObject } from "./declarative";
import type { StoreLinkProps } from "./store-link";

const {
  Component: { Badge, DrawerItem, DrawerTitle },
} = Renderer;

export interface ReconciliationSectionProps {
  object: DeclarativeObject;
  health: DeclarativeHealth;
  /** The other objects that target the same thing, and the store that links them. */
  rivals?: readonly DeclarativeObject[];
  store?: StoreLinkProps["store"];
  children?: React.ReactNode;
}

export function ReconciliationSection({ object, health, rivals = [], store, children }: ReconciliationSectionProps) {
  return (
    <>
      <DrawerTitle>Reconciliation</DrawerTitle>
      <DrawerItem name="Condition" labelsOnly>
        <Badge className={health.className} label={health.label} tooltip={health.reason} />
      </DrawerItem>
      <DrawerItem name="Status">
        <span data-testid="cnpg-declarative-status">{health.reason}</span>
      </DrawerItem>
      <DrawerItem name="Generation">{generationWords(object)}</DrawerItem>
      <DrawerItem name="Same target" hidden={rivals.length === 0}>
        <div data-testid="cnpg-declarative-rivals">
          {rivals.map((rival) => (
            <div key={rival.metadata?.name}>
              <StoreLink store={store} name={rival.metadata?.name} namespace={rival.metadata?.namespace} />
            </div>
          ))}
          <div>Only one object can manage it: the operator applies the first and ignores the others</div>
        </div>
      </DrawerItem>
      {children}
    </>
  );
}
