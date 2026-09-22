/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The facts of a `Cluster` the four declarative forms of SPEC-0027 read on
// open: whether its primary runs, the roles and databases it declares, its
// tablespaces and its external clusters. One reader, so the dialogs agree.

import { Cluster } from "../api/cnpg/cluster-v1";

import type { DeclarativeClusterChoice } from "./declarative-create";
import type { ExternalClusterChoice } from "./subscription-create";

export interface DeclarativeClusterFacts extends DeclarativeClusterChoice {
  /** The owner and the database of the bootstrap, `app` and `app` unless the cluster says otherwise. */
  bootstrapOwner: string;
  bootstrapDatabase: string;
  /** The names of `spec.managed.roles`. */
  managedRoles: string[];
  tablespaces: string[];
  externalClusters: ExternalClusterChoice[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => record(entry).name).filter((name): name is string => typeof name === "string")
    : [];
}

export function declarativeClusterFacts(item: Cluster): DeclarativeClusterFacts {
  const spec = record(item.spec);
  const bootstrap = record(spec.bootstrap);
  const source = record(bootstrap.initdb ?? bootstrap.recovery ?? bootstrap.pg_basebackup);
  const database = typeof source.database === "string" && source.database !== "" ? source.database : "app";
  const owner = typeof source.owner === "string" && source.owner !== "" ? source.owner : database;
  const replica = record(spec.replica);
  return {
    name: item.getName(),
    hibernated: Cluster.getHibernation(item),
    primaryRunning: Boolean(item.status?.currentPrimary) && Cluster.getReadyInstances(item) > 0,
    replica:
      replica.enabled === true ||
      (typeof replica.primary === "string" && replica.primary !== "" && replica.primary !== item.getName()),
    bootstrapOwner: owner,
    bootstrapDatabase: database,
    managedRoles: names(record(spec.managed).roles),
    tablespaces: names(spec.tablespaces),
    externalClusters: (Array.isArray(spec.externalClusters) ? spec.externalClusters : []).map((entry) => {
      const external = record(entry);
      const parameters = record(external.connectionParameters);
      const password = record(external.password);
      return {
        name: typeof external.name === "string" ? external.name : "",
        host: typeof parameters.host === "string" ? parameters.host : undefined,
        dbname: typeof parameters.dbname === "string" ? parameters.dbname : undefined,
        user: typeof parameters.user === "string" ? parameters.user : undefined,
        connectable: Object.keys(parameters).length > 0,
        hasPassword: typeof password.name === "string" && password.name !== "",
      };
    }),
  };
}
