/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The primary lease rows of the Cluster drawer (SPEC-0019): who holds the
// lease an instance needs before it promotes, since when, whether it is being
// renewed, and what its timings mean for a failover.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { getLeaseStore } from "../api/core/lease";
import { leaseOfCluster, leaseTimingWords, primaryLeaseHealth } from "../components/leases";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";

import type { Cluster } from "../api/cnpg/cluster-v1";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, LocaleDate, ReactiveDuration },
  K8sApi: { podsStore },
} = Renderer;

export interface ClusterLeaseRowsProps {
  cluster: Cluster;
}

export const ClusterLeaseRows = observer(({ cluster }: ClusterLeaseRowsProps) => {
  const namespace = cluster.metadata?.namespace ?? "";
  const leaseStore = getLeaseStore();

  useReferenceStores([{ label: "leases", store: leaseStore as never, namespaces: [namespace] }]);

  const lease = leaseOfCluster(cluster, leaseStore?.items ?? []);
  const health = primaryLeaseHealth(lease, cluster);
  const facts = health.facts;

  return (
    <>
      <DrawerItem name="Primary lease" labelsOnly>
        <span data-testid="cnpg-cluster-primary-lease">
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </span>
      </DrawerItem>
      <DrawerItem name="Lease status">
        <span data-testid="cnpg-cluster-primary-lease-status">{health.reason}</span>
      </DrawerItem>
      <DrawerItem name="Lease holder" hidden={!facts?.holder}>
        <StoreLink
          store={podsStore}
          name={facts?.holder}
          namespace={namespace}
          missing="The pod is not there (anymore)"
        />
      </DrawerItem>
      <DrawerItem name="Held since" hidden={!facts?.acquiredAt || !facts?.holder}>
        {facts?.acquiredAt ? <LocaleDate date={facts.acquiredAt.toISOString()} /> : null}
        {facts ? `, ${facts.transitions} ${facts.transitions === 1 ? "transition" : "transitions"} so far` : ""}
      </DrawerItem>
      <DrawerItem name="Last renewal" hidden={!facts?.renewedAt || !facts?.holder}>
        {facts?.renewedAt ? (
          <>
            <ReactiveDuration timestamp={facts.renewedAt.toISOString()} compact /> ago
          </>
        ) : null}
      </DrawerItem>
      <DrawerItem name="Lease timings" hidden={!lease}>
        {leaseTimingWords(cluster)}
      </DrawerItem>
    </>
  );
});
