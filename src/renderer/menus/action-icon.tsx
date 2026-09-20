/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The icon of every write action, in both surfaces one `kubeObjectMenuItems`
// registration reaches, and the one place that decides what a refused action
// looks like (SPEC-0020, W2). In the row menu the host already greys the whole
// item, icon and label together; in the toolbar of the drawer the label is
// hidden and the host's own dimming is too faint on the title bar, so the icon
// is dimmed further there, and only there.
//
// `Icon` has a `disabled` prop, but its stylesheet answers it with
// `color: inherit !important`, which throws away the title bar's own color and
// recolors the icon differently per theme: it is not used.

import { Renderer } from "@freelensapp/extensions";
import styles from "./action-icon.module.scss";
import stylesInline from "./action-icon.module.scss?inline";

const {
  Component: { Icon },
} = Renderer;

export interface ActionIconProps {
  /** A host Material ligature. */
  material: string;
  /** The verb, or the verb and the reason of the refusal: the same words the item's `title` carries. */
  tooltip: string;
  disabled: boolean;
  /** What the host passes for the toolbar of the drawer; absent in the row menu. */
  toolbar?: boolean;
}

export function ActionIcon({ material, tooltip, disabled, toolbar }: ActionIconProps) {
  const dimmed = disabled && Boolean(toolbar);

  return (
    <>
      {dimmed ? <style>{stylesInline}</style> : null}
      <Icon
        material={material}
        interactive={toolbar}
        tooltip={tooltip}
        tooltipOverrideDisabled
        className={dimmed ? styles.disabledIcon : undefined}
      />
    </>
  );
}
