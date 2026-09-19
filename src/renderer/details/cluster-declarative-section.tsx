/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The "Declarative objects" section of the Cluster drawer (SPEC-0013): what is
// declared inside the cluster, kind by kind, as counts by condition and a door
// to the list filtered by the cluster name. Hidden when nothing is declared.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Database } from "../api/cnpg/database-v1";
import { countHealth, countWords, databaseHealth, objectsOfCluster } from "../components/declarative";
import { useReferenceStores } from "../components/reference-loader";
import { DATABASES_PAGE_ID, extensionPageUrl } from "../navigation";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { DeclarativeCounts } from "../components/declarative";

const { observer } = MobxReact;

const {
  Component: { DrawerItem, DrawerTitle, MaybeLink },
} = Renderer;

export interface ClusterDeclarativeSectionProps {
  cluster: Cluster;
  extension: Renderer.LensExtension;
}

interface KindRow {
  label: string;
  testId: string;
  pageId: string;
  counts: DeclarativeCounts;
}

export const ClusterDeclarativeSection = observer(({ cluster, extension }: ClusterDeclarativeSectionProps) => {
  const namespace = cluster.metadata?.namespace ?? "";
  const name = cluster.metadata?.name ?? "";
  const databaseStore = maybe(() => Database.getStore<Database>());

  useReferenceStores([{ label: Database.crd.plural, store: databaseStore, namespaces: [namespace] }]);

  const lookup = { cluster, known: true };
  const rows: KindRow[] = [
    {
      label: "Databases",
      testId: "cnpg-cluster-databases",
      pageId: DATABASES_PAGE_ID,
      counts: countHealth(
        objectsOfCluster(cluster, databaseStore?.items ?? []).map((object) => databaseHealth(object, lookup)),
      ),
    },
  ].filter((row) => row.counts.total > 0);

  if (rows.length === 0) return null;

  return (
    <>
      <DrawerTitle>Declarative objects</DrawerTitle>
      {rows.map((row) => (
        <DrawerItem key={row.label} name={row.label}>
          <MaybeLink
            to={extensionPageUrl(extension.name, row.pageId, name)}
            onClick={(event) => event.stopPropagation()}
          >
            <span data-testid={row.testId}>{countWords(row.counts)}</span>
          </MaybeLink>
        </DrawerItem>
      ))}
    </>
  );
});
