/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What is declared inside a cluster, kind by kind, counted by condition
// (SPEC-0013 "Cluster drawer", and the Overview): one place that knows which
// health function reads which kind.

import { roleHealth } from "./database-roles";
import { countHealth, databaseHealth, objectsOfCluster } from "./declarative";
import { publicationHealth, subscriptionHealth } from "./logical-replication";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { DatabaseRole } from "../api/cnpg/database-role-v1";
import type { Database } from "../api/cnpg/database-v1";
import type { Publication } from "../api/cnpg/publication-v1";
import type { Subscription } from "../api/cnpg/subscription-v1";
import type { DeclarativeCounts } from "./declarative";

export const DECLARED_KINDS = ["Databases", "Database roles", "Publications", "Subscriptions"] as const;
export type DeclaredKind = (typeof DECLARED_KINDS)[number];

export interface DeclaredObjects {
  databases?: readonly Database[];
  roles?: readonly DatabaseRole[];
  publications?: readonly Publication[];
  subscriptions?: readonly Subscription[];
}

export function declaredCounts(
  cluster: Cluster,
  objects: DeclaredObjects,
  now: Date = new Date(),
): Record<DeclaredKind, DeclarativeCounts> {
  const lookup = { cluster, known: true };
  return {
    Databases: countHealth(
      objectsOfCluster(cluster, objects.databases ?? []).map((object) => databaseHealth(object, lookup)),
    ),
    "Database roles": countHealth(
      objectsOfCluster(cluster, objects.roles ?? []).map((object) => roleHealth(object, lookup, now)),
    ),
    Publications: countHealth(
      objectsOfCluster(cluster, objects.publications ?? []).map((object) => publicationHealth(object, lookup)),
    ),
    Subscriptions: countHealth(
      objectsOfCluster(cluster, objects.subscriptions ?? []).map((object) => subscriptionHealth(object, lookup)),
    ),
  };
}

/** How many declared objects of each kind failed, for one cluster. */
export function declaredFailures(
  cluster: Cluster,
  objects: DeclaredObjects,
  now: Date = new Date(),
): Record<DeclaredKind, number> {
  const counts = declaredCounts(cluster, objects, now);
  return {
    Databases: counts.Databases.failed,
    "Database roles": counts["Database roles"].failed,
    Publications: counts.Publications.failed,
    Subscriptions: counts.Subscriptions.failed,
  };
}
