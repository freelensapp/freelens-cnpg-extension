/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The backup method of a `Backup` or a `ScheduledBackup`. The in-tree
// `barmanObjectStore` method is deprecated upstream and is also what the CRD
// defaults to when no method is declared: it is shown with a "deprecated"
// badge that names the replacement, never as if it were current (DESIGN.md
// section 2, "Deprecated forms are labelled").

import { Renderer } from "@freelensapp/extensions";

import type { BackupMethod } from "../api/cnpg/backup-v1";

const {
  Component: { Badge, WithTooltip },
} = Renderer;

export interface MethodLabelProps {
  method: BackupMethod;
  /** False when the object declares no method and the CRD default applies. */
  declared: boolean;
}

export function MethodLabel({ method, declared }: MethodLabelProps) {
  if (method !== "barmanObjectStore") {
    return <WithTooltip>{method}</WithTooltip>;
  }
  return (
    <Badge
      className="warning"
      label="barmanObjectStore (deprecated)"
      tooltip={
        declared
          ? "The in-tree method is deprecated: use the Barman Cloud plugin instead"
          : "No method declared, so the deprecated CRD default applies: use the Barman Cloud plugin instead"
      }
    />
  );
}
