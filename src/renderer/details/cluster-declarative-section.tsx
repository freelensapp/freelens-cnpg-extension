/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The "Declarative objects" section of the Cluster drawer (SPEC-0013): what is
// declared inside the cluster, kind by kind, as counts by condition and a door
// to the list filtered by the cluster name, and the roles the cluster spec
// declares inline with what the operator says of each (SPEC-0014). Hidden when
// nothing is declared.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { Database } from "../api/cnpg/database-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { declaredInlineRoles, inlineStatusWords, roleHealth } from "../components/database-roles";
import { countHealth, countWords, databaseHealth, objectsOfCluster } from "../components/declarative";
import { publicationHealth, subscriptionHealth } from "../components/logical-replication";
import { useReferenceStores } from "../components/reference-loader";
import {
  DATABASE_ROLES_PAGE_ID,
  DATABASES_PAGE_ID,
  extensionPageUrl,
  PUBLICATIONS_PAGE_ID,
  SUBSCRIPTIONS_PAGE_ID,
} from "../navigation";
import styles from "./declarative-details.module.scss";
import stylesInline from "./declarative-details.module.scss?inline";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { DeclarativeCounts } from "../components/declarative";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, MaybeLink },
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
  const roleStore = maybe(() => DatabaseRole.getStore<DatabaseRole>());
  const publicationStore = maybe(() => Publication.getStore<Publication>());
  const subscriptionStore = maybe(() => Subscription.getStore<Subscription>());

  useReferenceStores([
    { label: Database.crd.plural, store: databaseStore, namespaces: [namespace] },
    { label: DatabaseRole.crd.plural, store: roleStore, namespaces: [namespace] },
    { label: Publication.crd.plural, store: publicationStore, namespaces: [namespace] },
    { label: Subscription.crd.plural, store: subscriptionStore, namespaces: [namespace] },
  ]);

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
    {
      label: "Database roles",
      testId: "cnpg-cluster-database-roles",
      pageId: DATABASE_ROLES_PAGE_ID,
      counts: countHealth(
        objectsOfCluster(cluster, roleStore?.items ?? []).map((object) => roleHealth(object, lookup)),
      ),
    },
    {
      label: "Publications",
      testId: "cnpg-cluster-publications",
      pageId: PUBLICATIONS_PAGE_ID,
      counts: countHealth(
        objectsOfCluster(cluster, publicationStore?.items ?? []).map((object) => publicationHealth(object, lookup)),
      ),
    },
    {
      label: "Subscriptions",
      testId: "cnpg-cluster-subscriptions",
      pageId: SUBSCRIPTIONS_PAGE_ID,
      counts: countHealth(
        objectsOfCluster(cluster, subscriptionStore?.items ?? []).map((object) => subscriptionHealth(object, lookup)),
      ),
    },
  ].filter((row) => row.counts.total > 0);
  // The roles the cluster spec declares inline are not objects, but they are
  // declared all the same, and the ones the operator cannot reconcile need a human.
  const inline = declaredInlineRoles(cluster);

  if (rows.length === 0 && inline.length === 0) return null;

  return (
    <>
      <style>{stylesInline}</style>
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
      <DrawerItem name="Roles in the cluster spec" hidden={inline.length === 0}>
        <div className={styles.list} data-testid="cnpg-cluster-inline-roles">
          {inline.map((role) => (
            <div key={role.name} className={styles.inlineRole}>
              <Badge className={role.className} label={role.name} />
              <span>{inlineStatusWords(role)}</span>
            </div>
          ))}
        </div>
      </DrawerItem>
    </>
  );
});
