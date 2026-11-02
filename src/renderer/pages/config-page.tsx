/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The PostgreSQL configuration of a cluster (SPEC-0035): `custom.conf` and
// `pg_hba.conf` of the primary as `kubectl cnpg status -v -v` prints them,
// read by main with two fixed `cat` commands (`main/primary-files.ts`), and
// the pending restart of each instance from its instance manager. Reads only.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { Cluster } from "../api/cnpg/cluster-v1";
import { createPodProxyClient, statusScheme } from "../api/instance/pod-proxy";
import { useAccessGuard } from "../components/access-review";
import { ClusterPickerPage } from "../components/cluster-picker-page";
import { withErrorPage } from "../components/error-page";
import {
  configParameters,
  filterHba,
  filterParameters,
  HBA_SECTION_WORDS,
  missingParameters,
  ORIGIN_WORDS,
  parseHba,
  restartWords,
} from "../components/pg-config";
import styles from "../components/pg-config.module.scss";
import { useReferenceStores } from "../components/reference-loader";
import { activeClusterId, cnpgIpc } from "../ipc";
import { configUrl, LIVE_CLUSTER_PARAM } from "../navigation";

import type { PrimaryFilesAnswer } from "../../common/ipc";
import type { InstanceRestart } from "../components/pg-config";

const { observer } = MobxReact;

const {
  Component: { Badge, MaybeLink, Notifications, SearchInput, Table, TableCell, TableHead, TableRow, WithTooltip },
  K8sApi: { podsStore },
  Navigation: { getDetailsUrl },
} = Renderer;

/** How often the strip asks the instance managers again. */
const STRIP_REFRESH_MS = 10_000;

type Tab = "config" | "hba";

function useInstanceRestarts(namespace: string, instances: readonly string[]): InstanceRestart[] | undefined {
  const [restarts, setRestarts] = React.useState<InstanceRestart[] | undefined>(undefined);
  const key = instances.join(",");
  React.useEffect(() => {
    const client = createPodProxyClient();
    let mounted = true;
    const read = async () => {
      // The scheme of the status port is the pod's (`--status-port-tls`): the pods are listed fresh first.
      await podsStore.loadAll({ namespaces: [namespace], merge: true }).catch(() => undefined);
      if (!mounted) return;
      const answers = await Promise.all(
        key
          .split(",")
          .filter(Boolean)
          .map(async (name) => {
            const pod = podsStore.getByName(name, namespace);
            const result = await client.getStatus(namespace, name, statusScheme(pod));
            return result.ok
              ? {
                  name,
                  pendingRestart: result.value.pendingRestart === true,
                  pendingRestartForDecrease: result.value.pendingRestartForDecrease === true,
                }
              : { name, pendingRestart: false, pendingRestartForDecrease: false, answered: false };
          }),
      );
      if (mounted) setRestarts(answers);
    };
    void read();
    const timer = setInterval(() => void read(), STRIP_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [namespace, key]);
  return restarts;
}

async function copyText(text: string, words: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    Notifications.ok(`Copied ${words} to the clipboard.`);
  } catch {
    Notifications.error("The clipboard refused the copy.");
  }
}

const ConfigPanel = observer(({ cluster }: { cluster: Cluster }) => {
  const namespace = cluster.getNs() ?? "";
  const name = cluster.getName();
  const primary = cluster.status?.currentPrimary;
  const spec = (cluster.spec?.postgresql?.parameters ?? {}) as Record<string, string>;
  const specRules = (cluster.spec?.postgresql as { pg_hba?: string[] } | undefined)?.pg_hba ?? [];
  const access = useAccessGuard([{ verb: "create", group: "", resource: "pods", subresource: "exec", namespace }]);
  const [answer, setAnswer] = React.useState<PrimaryFilesAnswer | undefined>(undefined);
  const [reading, setReading] = React.useState(false);
  const [reads, setReads] = React.useState(0);
  const [tab, setTab] = React.useState<Tab>("config");
  const [search, setSearch] = React.useState("");
  const restarts = useInstanceRestarts(namespace, cluster.status?.instanceNames ?? []);

  React.useEffect(() => {
    const clusterId = activeClusterId();
    const ipc = cnpgIpc();
    if (!access.enabled || !primary || !clusterId || !ipc) return;
    let mounted = true;
    setReading(true);
    void ipc
      .readPrimaryFiles({ clusterId, namespace, cluster: name, pod: primary })
      .then(
        (files) => mounted && setAnswer(files ?? { error: "main did not answer" }),
        () => mounted && setAnswer({ error: "main did not answer" }),
      )
      .finally(() => mounted && setReading(false));
    return () => {
      mounted = false;
    };
  }, [access.enabled, namespace, name, primary, reads]);

  // What the spec asks for stands in for the files only when they cannot be read, never while they are read.
  const fallback = !access.enabled || answer?.error !== undefined;
  const parameters = answer?.customConf !== undefined ? configParameters(answer.customConf, spec) : [];
  const rules = answer?.pgHbaConf !== undefined ? parseHba(answer.pgHbaConf) : [];
  const notYet = answer?.customConf !== undefined ? missingParameters(answer.customConf, spec) : [];
  const shownParameters = filterParameters(parameters, search);
  const shownRules = filterHba(rules, search);
  const detailsUrl = cluster.selfLink ? getDetailsUrl(cluster.selfLink) : undefined;

  return (
    <div className={styles.panel} data-testid="cnpg-config-panel">
      <div className={styles.strip} data-testid="cnpg-config-strip">
        {restarts === undefined ? (
          <span className={styles.note}>Asking the instance managers</span>
        ) : restarts.length === 0 ? (
          <span className={styles.note}>The cluster has no instance to ask</span>
        ) : (
          restarts.map((instance) => {
            const pending = instance.pendingRestart || instance.pendingRestartForDecrease;
            const silent = instance.answered === false;
            return (
              <span
                key={instance.name}
                className={styles.instance}
                data-testid={`cnpg-config-instance-${instance.name}`}
                data-pending={silent ? "unknown" : pending ? "true" : "false"}
              >
                <b>{instance.name}</b>
                {instance.name === primary ? " (primary)" : ""}
                <Badge
                  small
                  className={silent ? "info" : pending ? "warning" : "success"}
                  label={silent ? "no answer" : pending ? "restart pending" : "loaded"}
                />
                <span className={styles.note}>{restartWords(instance)}</span>
              </span>
            );
          })
        )}
        {restarts?.some((instance) => instance.pendingRestart || instance.pendingRestartForDecrease) && detailsUrl ? (
          <MaybeLink to={detailsUrl}>Open the cluster to restart an instance</MaybeLink>
        ) : null}
      </div>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={[styles.tab, tab === "config" ? styles.on : ""].join(" ").trim()}
          data-testid="cnpg-config-tab-config"
          onClick={() => setTab("config")}
        >
          Configuration
        </button>
        <button
          type="button"
          className={[styles.tab, tab === "hba" ? styles.on : ""].join(" ").trim()}
          data-testid="cnpg-config-tab-hba"
          onClick={() => setTab("hba")}
        >
          HBA rules
        </button>
        <div className={styles.search}>
          <SearchInput
            value={search}
            placeholder={tab === "config" ? "Filter the parameters" : "Filter the rules"}
            onChange={(value: string) => setSearch(value)}
            data-testid="cnpg-config-search"
          />
        </div>
        {answer?.customConf !== undefined ? (
          <button
            type="button"
            className={styles.button}
            data-testid="cnpg-config-copy"
            onClick={() =>
              void copyText(
                (tab === "config" ? answer.customConf : answer.pgHbaConf) ?? "",
                tab === "config" ? "custom.conf" : "pg_hba.conf",
              )
            }
          >
            Copy {tab === "config" ? "custom.conf" : "pg_hba.conf"}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.button}
          data-testid="cnpg-config-read"
          disabled={reading || !access.enabled}
          onClick={() => setReads((value) => value + 1)}
        >
          {reading ? "Reading" : "Read again"}
        </button>
      </div>

      <p className={styles.note}>
        {primary
          ? `As the operator wrote them on the primary ${primary}, read with kubectl exec (pods/exec).`
          : "The cluster has no primary to read from."}
      </p>
      {!access.enabled ? (
        <p className={styles.error} data-testid="cnpg-config-denied">
          {access.reason}. Below, what the spec asks for.
        </p>
      ) : null}
      {answer?.error ? (
        <p className={styles.error} data-testid="cnpg-config-error">
          {answer.error}
        </p>
      ) : null}
      {notYet.length > 0 ? (
        <p className={styles.note} data-testid="cnpg-config-not-yet">
          In the spec, not in the file yet: {notYet.join(", ")}.
        </p>
      ) : null}

      {tab === "config" ? (
        <div className={styles.table} data-testid="cnpg-config-parameters">
          <Table scrollable={false} sortSyncWithUrl={false}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.name}>Parameter</TableCell>
              <TableCell className={styles.value}>Value</TableCell>
              <TableCell className={styles.origin}>From</TableCell>
            </TableHead>
            {(answer?.customConf !== undefined || !fallback
              ? shownParameters
              : filterParameters(
                  Object.entries(spec).map(([key, value]) => ({ name: key, value, origin: "spec" as const })),
                  search,
                )
            ).map((row) => (
              <TableRow key={row.name} nowrap>
                <TableCell className={styles.name}>
                  <span className={styles.mono} data-testid={`cnpg-config-param-${row.name}`} data-origin={row.origin}>
                    {row.name}
                  </span>
                </TableCell>
                <TableCell className={styles.value}>
                  <span className={styles.mono}>{row.value === "" ? "''" : row.value}</span>
                  {"specValue" in row && row.specValue !== undefined ? (
                    <span className={styles.note}> (the spec asks {row.specValue})</span>
                  ) : null}
                </TableCell>
                <TableCell className={styles.origin}>
                  <WithTooltip>{ORIGIN_WORDS[row.origin]}</WithTooltip>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      ) : (
        <div className={styles.table} data-testid="cnpg-config-hba">
          <Table scrollable={false} sortSyncWithUrl={false}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.narrow}>Type</TableCell>
              <TableCell className={styles.name}>Database</TableCell>
              <TableCell className={styles.name}>User</TableCell>
              <TableCell className={styles.name}>Address</TableCell>
              <TableCell className={styles.method}>Method</TableCell>
              <TableCell className={styles.value}>Options</TableCell>
              <TableCell className={styles.origin}>From</TableCell>
            </TableHead>
            {(answer?.pgHbaConf !== undefined || !fallback
              ? shownRules
              : filterHba(parseHba(`# USER-DEFINED RULES\n${specRules.join("\n")}`), search)
            ).map((rule) => (
              <TableRow key={rule.line} nowrap>
                <TableCell className={styles.narrow}>
                  <span data-testid={`cnpg-config-hba-${rule.line}`} data-section={rule.section}>
                    {rule.type}
                  </span>
                </TableCell>
                <TableCell className={styles.name}>{rule.database}</TableCell>
                <TableCell className={styles.name}>
                  <WithTooltip>{rule.user}</WithTooltip>
                </TableCell>
                <TableCell className={styles.name}>{rule.address ?? ""}</TableCell>
                <TableCell className={styles.method}>{rule.method}</TableCell>
                <TableCell className={styles.value}>
                  <span className={styles.mono}>{rule.options ?? ""}</span>
                </TableCell>
                <TableCell className={styles.origin}>{HBA_SECTION_WORDS[rule.section]}</TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
});

export interface ConfigPageProps {
  extension: Renderer.LensExtension;
}

export const ConfigPage = observer((props: ConfigPageProps) =>
  withErrorPage(props, () => {
    const { extension } = props;

    useReferenceStores([{ label: Cluster.crd.plural, store: Cluster.getStore<Cluster>() }]);

    return (
      <ClusterPickerPage
        extension={extension}
        title="PostgreSQL configuration"
        testId="cnpg-config"
        paramName={LIVE_CLUSTER_PARAM}
        urlOf={(namespace, name) => configUrl(extension.name, namespace, name)}
      >
        {(cluster, key) => <ConfigPanel key={key} cluster={cluster} />}
      </ClusterPickerPage>
    );
  }),
);
