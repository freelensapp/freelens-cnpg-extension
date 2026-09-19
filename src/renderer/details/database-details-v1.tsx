/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Database drawer (SPEC-0013): whether PostgreSQL has the database as
// declared and, when it has not, which part failed; the declaration in words;
// the size and the sessions of the database right now, from the exporter of
// the primary; the objects the operator manages inside it, one by one.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Database } from "../api/cnpg/database-v1";
import { exactBytes, formatBytes } from "../components/bytes";
import {
  clusterOf,
  conflictingObjects,
  connectionLimitWords,
  creationParameters,
  databaseHealth,
  managedObjects,
  reclaimWords,
} from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { readDatabase, sessionsWords } from "../components/live/database-reading";
import { formatCount } from "../components/live/format";
import { ReconciliationSection } from "../components/reconciliation-section";
import { useReferenceStores } from "../components/reference-loader";
import { RightNow } from "../components/right-now";
import { StoreLink } from "../components/store-link";
import styles from "./declarative-details.module.scss";
import stylesInline from "./declarative-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, BadgeBoolean, DrawerItem, DrawerTitle, Table, TableCell, TableHead, TableRow, WithTooltip },
} = Renderer;

const LEVEL_CLASS = { ok: "success", warning: "warning", error: "error" } as const;

export interface DatabaseDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Database> {
  extension: Renderer.LensExtension;
}

export const DatabaseDetails = observer((props: DatabaseDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== Database.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const databaseStore = maybe(() => Database.getStore<Database>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: Database.crd.plural, store: databaseStore, namespaces: [namespace] },
    ]);

    const spec = object.spec;
    const cluster = clusterOf(object, clusterStore?.items ?? []);
    const health = databaseHealth(object, { cluster, known: Boolean(clusterStore?.isLoaded) });
    const rivals = conflictingObjects(object, databaseStore?.items ?? []);
    const objects = managedObjects(object);
    const created = creationParameters(object);
    const datname = spec?.name ?? "";
    const absent = spec?.ensure === "absent";

    return (
      <>
        <style>{stylesInline}</style>

        <ReconciliationSection object={object} health={health} rivals={rivals} store={databaseStore} />

        <DrawerTitle>Database</DrawerTitle>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={Database.getClusterName(object)}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Name in PostgreSQL">
          <span className={styles.mono}>{datname || "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="Owner">
          <span className={styles.mono}>{spec?.owner ?? "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="Ensure">
          {absent ? "absent: the operator drops the database if it is there" : "present"}
        </DrawerItem>
        <DrawerItem name="Reclaim policy">{reclaimWords(spec?.databaseReclaimPolicy, "database")}</DrawerItem>
        <DrawerItem name="Connection limit">{connectionLimitWords(spec?.connectionLimit)}</DrawerItem>
        <DrawerItem name="Allows connections" labelsOnly>
          <BadgeBoolean value={spec?.allowConnections ?? true} />
        </DrawerItem>
        <DrawerItem name="Template database" hidden={!spec?.isTemplate}>
          Yes: any user with CREATEDB can clone it
        </DrawerItem>
        <DrawerItem name="Tablespace" hidden={!spec?.tablespace}>
          <span className={styles.mono}>{spec?.tablespace}</span>
        </DrawerItem>
        {created.map((parameter) => (
          <DrawerItem key={parameter.name} name={parameter.name}>
            <span className={styles.mono}>{parameter.value}</span>
          </DrawerItem>
        ))}
        {created.length > 0 ? (
          <div className={styles.note}>
            PostgreSQL sets these at creation only: a change here is ignored for a database that already exists.
          </div>
        ) : null}

        {absent ? null : (
          <>
            <DrawerTitle>Right now</DrawerTitle>
            <RightNow
              cluster={cluster}
              testId="cnpg-database-live"
              nobody={
                cluster ? "The cluster has no primary to ask" : "The Cluster is not there: there is no primary to ask"
              }
            >
              {(samples) => {
                const reading = readDatabase(samples, datname);
                if (!reading) {
                  return <DrawerItem name="Database">PostgreSQL does not have a database named {datname}</DrawerItem>;
                }
                return (
                  <>
                    <DrawerItem name="Size">
                      <WithTooltip
                        tooltip={reading.sizeBytes === undefined ? undefined : exactBytes(reading.sizeBytes)}
                      >
                        <span data-testid="cnpg-database-size">
                          {reading.sizeBytes === undefined ? "N/A" : formatBytes(reading.sizeBytes)}
                        </span>
                      </WithTooltip>
                    </DrawerItem>
                    <DrawerItem name="Sessions">{sessionsWords(reading)}</DrawerItem>
                    <DrawerItem name="Transaction ID age" labelsOnly>
                      <Badge
                        className={LEVEL_CLASS[reading.xidLevel]}
                        label={formatCount(reading.xidAge)}
                        tooltip="Transactions since the oldest frozen one; PostgreSQL forces a vacuum long before 2 billion. A warning above 1 billion"
                      />
                    </DrawerItem>
                  </>
                );
              }}
            </RightNow>
          </>
        )}

        {objects.length > 0 ? (
          <>
            <DrawerTitle>Managed objects</DrawerTitle>
            <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
              <TableHead flat sticky={false}>
                <TableCell className={styles.kind}>Kind</TableCell>
                <TableCell className={styles.name}>Name</TableCell>
                <TableCell className={styles.detail}>Detail</TableCell>
                <TableCell className={styles.ensure}>Ensure</TableCell>
                <TableCell className={styles.applied}>Applied</TableCell>
                <TableCell className={styles.message}>Message</TableCell>
              </TableHead>
              {objects.map((row) => (
                <TableRow key={`${row.kind}/${row.name}`} nowrap>
                  <TableCell className={styles.kind}>{row.kind}</TableCell>
                  <TableCell className={styles.name}>
                    <WithTooltip>{row.name}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.detail}>
                    <WithTooltip>{row.detail || "N/A"}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.ensure}>{row.ensure}</TableCell>
                  <TableCell className={styles.applied}>
                    {row.applied === undefined ? (
                      <WithTooltip tooltip="The operator has not reported on it">N/A</WithTooltip>
                    ) : (
                      <BadgeBoolean value={row.applied} />
                    )}
                  </TableCell>
                  <TableCell className={styles.message}>
                    <WithTooltip>{row.message ?? (row.applied ? "Applied" : "N/A")}</WithTooltip>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </>
        ) : null}
      </>
    );
  }),
);
