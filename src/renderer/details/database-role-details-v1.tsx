/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Database Role drawer (SPEC-0014): whether PostgreSQL has the role as
// declared, what the role may do, and how it authenticates and until when.
// The Secrets are links: the extension knows their names, never their content.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import {
  certificateFacts,
  expiryWords,
  inlineRival,
  passwordFacts,
  roleAttributes,
  roleHealth,
} from "../components/database-roles";
import { clusterOf, conflictingObjects, connectionLimitWords, reclaimWords } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { ReconciliationSection } from "../components/reconciliation-section";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./declarative-details.module.scss";
import stylesInline from "./declarative-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, LocaleDate },
  K8sApi: { secretsStore },
} = Renderer;

const CERTIFICATE_CLASS = {
  off: "info",
  pending: "info",
  ok: "success",
  renewing: "info",
  expired: "warning",
} as const;

export interface DatabaseRoleDetailsProps extends Renderer.Component.KubeObjectDetailsProps<DatabaseRole> {
  extension: Renderer.LensExtension;
}

export const DatabaseRoleDetails = observer((props: DatabaseRoleDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== DatabaseRole.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const roleStore = maybe(() => DatabaseRole.getStore<DatabaseRole>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: DatabaseRole.crd.plural, store: roleStore, namespaces: [namespace] },
      { label: "secrets", store: secretsStore, namespaces: [namespace] },
    ]);

    const now = new Date();
    const spec = object.spec;
    const cluster = clusterOf(object, clusterStore?.items ?? []);
    const health = roleHealth(object, { cluster, known: Boolean(clusterStore?.isLoaded) }, now);
    const rivals = conflictingObjects(object, roleStore?.items ?? []);
    const inline = inlineRival(object, cluster);
    const attributes = roleAttributes(spec);
    const password = passwordFacts(spec, now);
    const certificate = certificateFacts(object, now);
    const memberOf = spec?.inRoles ?? [];

    return (
      <>
        <style>{stylesInline}</style>

        <ReconciliationSection object={object} health={health} rivals={rivals} store={roleStore}>
          <DrawerItem name="Cluster spec" hidden={!inline}>
            <span data-testid="cnpg-role-inline-rival">
              The cluster declares the role {inline?.name} in managed.roles. The cluster spec wins: remove that entry to
              hand the role over to this object
            </span>
          </DrawerItem>
        </ReconciliationSection>

        <DrawerTitle>Role</DrawerTitle>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={DatabaseRole.getClusterName(object)}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Name in PostgreSQL">
          <span className={styles.mono}>{spec?.name ?? "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="Comment" hidden={!spec?.comment}>
          {spec?.comment}
        </DrawerItem>
        <DrawerItem name="Attributes" labelsOnly={attributes.length > 0}>
          {attributes.length === 0 ? (
            "None: a group role, it cannot log in and grants what is granted to it"
          ) : (
            <div className={styles.badges} data-testid="cnpg-role-attributes">
              {attributes.map((attribute) => (
                <Badge
                  key={attribute.label}
                  className={attribute.className}
                  label={attribute.label}
                  tooltip={attribute.tooltip}
                />
              ))}
            </div>
          )}
        </DrawerItem>
        <DrawerItem name="Member of">
          {memberOf.length > 0 ? <span className={styles.mono}>{memberOf.join(", ")}</span> : "No role"}
        </DrawerItem>
        <DrawerItem name="Connection limit">{connectionLimitWords(spec?.connectionLimit)}</DrawerItem>
        <DrawerItem name="Reclaim policy">{reclaimWords(spec?.databaseRoleReclaimPolicy, "role")}</DrawerItem>

        <DrawerTitle>Authentication</DrawerTitle>
        <DrawerItem name="Can log in" hidden={Boolean(spec?.login)}>
          No: without the login attribute neither a password nor a certificate lets it in
        </DrawerItem>
        <DrawerItem name="Password">
          {password.source === "secret" ? (
            <StoreLink
              store={secretsStore}
              name={password.secretName}
              namespace={namespace}
              missing="The Secret is not there (yet)"
            />
          ) : password.source === "disabled" ? (
            "Disabled: the operator sets it to NULL"
          ) : (
            "Not managed: the operator leaves the password of the role as it is"
          )}
        </DrawerItem>
        <DrawerItem name="Password valid until">
          {password.validUntil ? (
            <span className={password.expired ? styles.warning : undefined} data-testid="cnpg-role-valid-until">
              <LocaleDate date={password.validUntil.toISOString()} /> ({expiryWords(password, now)})
            </span>
          ) : (
            "Forever: the role declares no expiry"
          )}
        </DrawerItem>
        <DrawerItem name="Client certificate" labelsOnly>
          <Badge
            className={CERTIFICATE_CLASS[certificate.state]}
            label={certificate.state === "off" ? "Not issued" : certificate.words}
            tooltip={
              certificate.state === "off"
                ? certificate.words
                : "Issued by the operator, signed by the client CA of the cluster, renewed in its last 7 days"
            }
          />
        </DrawerItem>
        <DrawerItem name="Certificate secret" hidden={!certificate.secretName}>
          <StoreLink
            store={secretsStore}
            name={certificate.secretName}
            namespace={namespace}
            missing="The Secret is not there (yet)"
          />
        </DrawerItem>
        <DrawerItem name="Certificate expires" hidden={!certificate.expiresAt}>
          {certificate.expiresAt ? <LocaleDate date={certificate.expiresAt.toISOString()} /> : null}
        </DrawerItem>
        <DrawerItem name="Operator's note" hidden={!certificate.message || certificate.state === "pending"}>
          {certificate.message}
        </DrawerItem>
      </>
    );
  }),
);
