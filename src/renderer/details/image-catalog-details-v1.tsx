/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The drawer of an ImageCatalog and of a ClusterImageCatalog (SPEC-0010): what
// the catalog offers per major, and which clusters follow it, with the image
// each of them runs next to the image the catalog offers.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { withErrorPage } from "../components/error-page";
import { catalogMajors, classifyCatalog, clustersOfCatalog, imageShort, imageTag } from "../components/image-catalogs";
import { poolersOfCatalog } from "../components/poolers";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./image-catalog-details.module.scss";
import stylesInline from "./image-catalog-details.module.scss?inline";

import type { AnyImageCatalog } from "../api/cnpg/image-catalog-v1";
import type { FollowerState } from "../components/image-catalogs";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, Table, TableCell, TableHead, TableRow, WithTooltip },
} = Renderer;

const FOLLOWER_CLASS: Record<FollowerState, string> = {
  Aligned: "success",
  "Rolling out": "warning",
  "Missing major": "error",
};

const CATALOG_KINDS: readonly string[] = ["ImageCatalog", "ClusterImageCatalog"];

export interface ImageCatalogDetailsProps extends Renderer.Component.KubeObjectDetailsProps<AnyImageCatalog> {
  extension: Renderer.LensExtension;
}

export const ImageCatalogDetails = observer((props: ImageCatalogDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || !CATALOG_KINDS.includes(object.kind ?? "")) {
      return <></>;
    }

    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const poolerStore = maybe(() => Pooler.getStore<Pooler>());
    const clusterScoped = object.kind === "ClusterImageCatalog";

    // A cluster scoped catalog may be followed from any namespace.
    useReferenceStores([
      {
        label: Cluster.crd.plural,
        store: clusterStore,
        namespaces: clusterScoped ? undefined : [object.getNs() ?? ""],
      },
      {
        label: Pooler.crd.plural,
        store: poolerStore,
        namespaces: clusterScoped ? undefined : [object.getNs() ?? ""],
      },
    ]);

    const poolers = poolersOfCatalog(object, (poolerStore?.items ?? []) as Pooler[]);
    const clusters = (clusterStore?.items ?? []) as Cluster[];
    const health = classifyCatalog(object, clusters);
    const majors = catalogMajors(object);
    const followers = clustersOfCatalog(object, clusters);
    const components = object.spec?.componentImages ?? [];

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Catalog</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{health.reason}</DrawerItem>
        <DrawerItem name="Scope">
          {clusterScoped
            ? "The whole Kubernetes cluster: any PostgreSQL cluster can follow it"
            : `The namespace ${object.getNs()}: only its PostgreSQL clusters can follow it`}
        </DrawerItem>

        <DrawerTitle>Images</DrawerTitle>
        {majors.length === 0 ? (
          <DrawerItem name="Images">The catalog offers no image</DrawerItem>
        ) : (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.major}>Major</TableCell>
              <TableCell className={styles.image}>Image</TableCell>
              <TableCell className={styles.extensions}>Extensions</TableCell>
            </TableHead>
            {majors.map((entry) => (
              <TableRow key={entry.major} nowrap>
                <TableCell className={styles.major}>{entry.major}</TableCell>
                <TableCell className={styles.image}>
                  <WithTooltip tooltip={entry.image}>
                    <span className={styles.mono}>{imageShort(entry.image)}</span>
                  </WithTooltip>
                </TableCell>
                <TableCell className={styles.extensions}>
                  <WithTooltip>{entry.extensions.join(", ") || "none"}</WithTooltip>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}

        {components.length > 0 ? (
          <>
            <DrawerTitle>Component images</DrawerTitle>
            {components.map((component) => (
              <DrawerItem key={component.key} name={component.key}>
                <span className={styles.mono}>{component.image}</span>
              </DrawerItem>
            ))}
          </>
        ) : null}

        <DrawerTitle>Clusters</DrawerTitle>
        {followers.length === 0 ? (
          <DrawerItem name="Followers">No cluster takes its image from this catalog</DrawerItem>
        ) : (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.cluster}>Cluster</TableCell>
              <TableCell className={styles.major}>Major</TableCell>
              <TableCell className={styles.tag}>In the catalog</TableCell>
              <TableCell className={styles.tag}>Running</TableCell>
              <TableCell className={styles.state}>State</TableCell>
            </TableHead>
            {followers.map((follower) => (
              <TableRow key={`${follower.namespace}/${follower.name}`} nowrap>
                <TableCell className={styles.cluster}>
                  <StoreLink store={clusterStore} name={follower.name} namespace={follower.namespace} />
                </TableCell>
                <TableCell className={styles.major}>{follower.major}</TableCell>
                <TableCell className={styles.tag}>
                  <WithTooltip tooltip={follower.offered}>
                    {follower.offered ? imageTag(follower.offered) : "not offered"}
                  </WithTooltip>
                </TableCell>
                <TableCell className={styles.tag}>
                  <WithTooltip tooltip={follower.running}>
                    {follower.running ? imageTag(follower.running) : "N/A"}
                  </WithTooltip>
                </TableCell>
                <TableCell className={styles.state}>
                  <Badge small className={FOLLOWER_CLASS[follower.state]} label={follower.state} />
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}

        {poolers.length > 0 ? (
          <>
            <DrawerTitle>Poolers</DrawerTitle>
            {poolers.map((entry) => (
              <DrawerItem key={`${entry.namespace}/${entry.name}`} name={`Key ${entry.key || "N/A"}`}>
                <StoreLink store={poolerStore} name={entry.name} namespace={entry.namespace} />
                <span className={styles.mono}>
                  {" "}
                  {entry.offered ? imageShort(entry.offered) : "not offered under that key"}
                </span>
              </DrawerItem>
            ))}
          </>
        ) : null}
      </>
    );
  }),
);
