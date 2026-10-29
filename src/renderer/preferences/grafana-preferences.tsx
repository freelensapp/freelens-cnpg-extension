/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The preferences of the extension (SPEC-0039): per Kubernetes cluster of the
// catalog, the base URL of the team's Grafana and the UID of the
// CloudNativePG dashboard. Links only: nothing is sent to Grafana, and no
// credential is asked for or stored.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { CnpgPreferencesStore, DEFAULT_DASHBOARD_UID } from "../../common/preferences-store";
import { checkGrafanaUrl } from "../components/grafana";
import styles from "./grafana-preferences.module.scss";

const { observer } = MobxReact;

const {
  Component: { Input },
} = Renderer;

export const GrafanaPreferencesInput = observer(() => {
  const preferences = CnpgPreferencesStore.getInstanceOrCreate<CnpgPreferencesStore>();
  const clusters = [...Renderer.Catalog.getAllClusters()].sort((a, b) => a.name.localeCompare(b.name));
  if (clusters.length === 0) {
    return <p className={styles.muted}>No Kubernetes cluster in the catalog yet.</p>;
  }
  return (
    <div className={styles.grid} data-testid="cnpg-preferences-grafana">
      {clusters.map((cluster) => {
        const settings = preferences.grafana[cluster.id] ?? { url: "", dashboardUid: "" };
        const { problem } = checkGrafanaUrl(settings.url);
        return (
          <div key={cluster.id} className={styles.row} data-testid={`cnpg-preferences-grafana-${cluster.contextName}`}>
            <span className={styles.name} title={`${cluster.contextName} in ${cluster.kubeConfigPath}`}>
              {cluster.name}
            </span>
            <div>
              <Input
                data-testid={`cnpg-grafana-url-${cluster.contextName}`}
                placeholder="https://grafana.example.com"
                value={settings.url}
                onChange={(url: string) => preferences.setGrafana(cluster.id, { ...settings, url })}
              />
              {problem ? <span className={styles.problem}>{problem}</span> : null}
            </div>
            <Input
              data-testid={`cnpg-grafana-uid-${cluster.contextName}`}
              placeholder={DEFAULT_DASHBOARD_UID}
              value={settings.dashboardUid}
              onChange={(dashboardUid: string) => preferences.setGrafana(cluster.id, { ...settings, dashboardUid })}
            />
          </div>
        );
      })}
    </div>
  );
});

export const GrafanaPreferencesHint = () => (
  <span>
    The CloudNativePG dashboard of grafana-dashboards (UID {DEFAULT_DASHBOARD_UID}) unless another UID is given. The
    drawer of a cluster and the Live View then open it in the browser for that cluster, over the range of the Live View.
    A link only: the extension sends nothing to Grafana and stores no credential.
  </span>
);
