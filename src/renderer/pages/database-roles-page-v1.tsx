/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Database Roles list (SPEC-0014): every role declared for a cluster, what
// it may do, how it authenticates and until when, and whether PostgreSQL has
// it as declared.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole, type DatabaseRoleApi } from "../api/cnpg/database-role-v1";
import { openCreateDatabaseRoleDialog } from "../components/database-role-create-dialog";
import { expiryWords, passwordFacts, roleAttributeWords, roleHealth } from "../components/database-roles";
import { clusterOf } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./database-roles-page.module.scss";
import stylesInline from "./database-roles-page.module.scss?inline";

import type { ClusterLookup } from "../components/declarative";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = DatabaseRole;
type KubeObject = DatabaseRole;
type KubeObjectApi = DatabaseRoleApi;

function lookup(object: KubeObject): ClusterLookup {
  const store = maybe(() => Cluster.getStore<Cluster>());
  return { cluster: clusterOf(object, store?.items ?? []), known: Boolean(store?.isLoaded) };
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  role: (object: KubeObject) => object.spec?.name ?? "",
  attributes: (object: KubeObject) => roleAttributeWords(object.spec),
  memberOf: (object: KubeObject) => (object.spec?.inRoles ?? []).join(", "),
  expires: (object: KubeObject) => passwordFacts(object.spec).validUntil?.getTime() ?? Number.MAX_SAFE_INTEGER,
  condition: (object: KubeObject) => roleHealth(object, lookup(object)).state,
  status: (object: KubeObject) => roleHealth(object, lookup(object)).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Role", sortBy: "role", className: styles.role },
  { title: "Attributes", sortBy: "attributes", className: styles.attributes },
  { title: "Member of", sortBy: "memberOf", className: styles.memberOf },
  { title: "Expires", sortBy: "expires", className: styles.expires },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface DatabaseRolesPageProps {
  extension: Renderer.LensExtension;
}

export const DatabaseRolesPage = observer((props: DatabaseRolesPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgDatabaseRolesTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [
              KubeObject.getClusterName(object) ?? "",
              object.spec?.name ?? "",
              roleAttributeWords(object.spec),
              passwordFacts(object.spec).words,
              ...(object.spec?.inRoles ?? []),
              roleHealth(object, lookup(object)).state,
            ],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreateDatabaseRoleDialog(), addTooltip: "Create database role" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const now = new Date();
            const health = roleHealth(object, lookup(object), now);
            const password = passwordFacts(object.spec, now);
            const memberOf = object.spec?.inRoles ?? [];

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
              <StoreLink
                key="cluster"
                store={clusterStore}
                name={KubeObject.getClusterName(object)}
                namespace={object.getNs()}
                missing="The Cluster is not there (anymore)"
              />,
              <WithTooltip key="role" tooltip="The name of the role inside PostgreSQL">
                {object.spec?.name ?? "N/A"}
              </WithTooltip>,
              <WithTooltip key="attributes">{roleAttributeWords(object.spec)}</WithTooltip>,
              <WithTooltip key="memberOf">{memberOf.length > 0 ? memberOf.join(", ") : "N/A"}</WithTooltip>,
              <WithTooltip
                key="expires"
                tooltip={`Password: ${password.words.toLowerCase()}; ${
                  password.validUntil ? `valid until ${password.validUntil.toISOString()}` : "it never expires"
                }`}
              >
                <span className={password.expired ? styles.expired : undefined}>{expiryWords(password, now)}</span>
              </WithTooltip>,
              <Badge key="condition" className={health.className} label={health.label} tooltip={health.reason} />,
              <WithTooltip key="status">{health.reason}</WithTooltip>,
              <KubeObjectAge key="age" object={object} />,
            ];
          }}
        />
      </>
    );
  }),
);
