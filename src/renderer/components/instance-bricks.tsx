/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One StatusBrick per instance, the dense per-unit gallery DESIGN.md section 2
// reserves the brick for: the primary carries a mark, fenced instances are
// dimmed, and the tooltip carries the exact facts behind the color.

import { Renderer } from "@freelensapp/extensions";
import styles from "./instance-bricks.module.scss";
import stylesInline from "./instance-bricks.module.scss?inline";

import type { InstanceFact, InstanceHealth } from "./cluster-health";

const {
  Component: { StatusBrick },
} = Renderer;

/** Brick class per instance health; the classes map to the theme tokens in the module stylesheet. */
const HEALTH_CLASS: Record<InstanceHealth, string> = {
  healthy: styles.healthy,
  replicating: styles.replicating,
  failed: styles.failed,
  unknown: styles.unknown,
};

function describe(instance: InstanceFact): string {
  const parts = [instance.name, instance.role, instance.health];
  if (instance.fenced) parts.push("fenced");
  if (instance.node) parts.push(`node ${instance.node}`);
  if (instance.ip) parts.push(instance.ip);
  if (instance.timeline !== undefined) parts.push(`timeline ${instance.timeline}`);
  return parts.join(", ");
}

export interface InstanceBricksProps {
  instances: readonly InstanceFact[];
}

export function InstanceBricks({ instances }: InstanceBricksProps) {
  if (instances.length === 0) return null;

  return (
    <>
      <style>{stylesInline}</style>
      <span className={styles.bricks} data-testid="cnpg-instance-bricks">
        {instances.map((instance) => (
          <StatusBrick
            key={instance.name}
            className={[
              HEALTH_CLASS[instance.health],
              instance.role === "primary" ? styles.primary : "",
              instance.fenced ? styles.fenced : "",
            ]
              .filter(Boolean)
              .join(" ")}
            tooltip={describe(instance)}
            data-instance={instance.name}
            data-role={instance.role}
          />
        ))}
      </span>
    </>
  );
}
