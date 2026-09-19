/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Failover Quorum drawer (SPEC-0011): the quorum check in words, the
// numbers behind it, and the standbys it names. What the drawer says is an
// estimate for the reader: the operator's own check, at failover time, is the
// authority, and the drawer says so.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { FailoverQuorum } from "../api/cnpg/failover-quorum-v1";
import { withErrorPage } from "../components/error-page";
import { clusterOfQuorum, quorumFacts } from "../components/failover-quorum";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./image-catalog-details.module.scss";
import stylesInline from "./image-catalog-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, BadgeBoolean, DrawerItem, DrawerTitle, Table, TableCell, TableHead, TableRow },
  K8sApi: { podsStore },
} = Renderer;

export interface FailoverQuorumDetailsProps extends Renderer.Component.KubeObjectDetailsProps<FailoverQuorum> {
  extension: Renderer.LensExtension;
}

export const FailoverQuorumDetails = observer((props: FailoverQuorumDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== FailoverQuorum.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: "pods", store: podsStore, namespaces: [namespace] },
    ]);

    const cluster = clusterOfQuorum(object, (clusterStore?.items ?? []) as Cluster[]);
    const facts = quorumFacts(object, cluster);

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Quorum</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={facts.className} label={facts.label} tooltip={facts.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{facts.reason}</DrawerItem>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={object.getName()}
            namespace={namespace}
            missing="Its cluster is not there"
          />
        </DrawerItem>
        <DrawerItem name="Method">
          {facts.method === "FIRST"
            ? "FIRST: the first named standbys, in order"
            : facts.method === "ANY"
              ? "ANY: any of the named standbys"
              : (facts.method ?? "N/A")}
        </DrawerItem>
        <DrawerItem name="Must confirm">{facts.mustConfirm} (W: the standbys a commit waits for)</DrawerItem>
        <DrawerItem name="Named standbys">{facts.named} (N: the potentially synchronous standbys)</DrawerItem>
        <DrawerItem name="Healthy among them" hidden={!cluster}>
          {facts.healthy} (R as this view can see it, from the status of the cluster)
        </DrawerItem>
        <DrawerItem name="Written by" hidden={!facts.writtenBy}>
          <StoreLink store={podsStore} name={facts.writtenBy} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="How to read it">
          Before promoting a replica the operator checks that R + W is greater than N, so that one of the promotable
          replicas is sure to hold every synchronous commit; otherwise it promotes nothing and waits. The operator's own
          check at failover time is the authority: this view estimates R from the status of the cluster.
        </DrawerItem>

        <DrawerTitle>Standbys</DrawerTitle>
        {facts.standbys.length === 0 ? (
          <DrawerItem name="Standbys">None named</DrawerItem>
        ) : (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.cluster}>Instance</TableCell>
              <TableCell className={styles.state}>Healthy</TableCell>
            </TableHead>
            {facts.standbys.map((standby) => (
              <TableRow key={standby.name} nowrap>
                <TableCell className={styles.cluster}>
                  <StoreLink store={podsStore} name={standby.name} namespace={namespace} />
                </TableCell>
                <TableCell className={styles.state}>
                  {standby.healthy === undefined ? <BadgeBoolean /> : <BadgeBoolean value={standby.healthy} />}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </>
    );
  }),
);
