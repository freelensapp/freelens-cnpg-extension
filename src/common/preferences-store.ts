/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The extension's preferences (SPEC-0039): per Kubernetes cluster of the
// catalog, the base URL of the team's Grafana and the UID of the CloudNativePG
// dashboard. No credential is ever stored. Main and the renderer both load it,
// as the template does: main keeps the file, the renderer edits and reads it.

import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observableRef } from "mobx";

/** The UID of the dashboard of cloudnative-pg/grafana-dashboards (charts/cluster). */
export const DEFAULT_DASHBOARD_UID = "cloudnative-pg";

export interface GrafanaSettings {
  url: string;
  /** Empty for the default dashboard. */
  dashboardUid: string;
}

export interface CnpgPreferencesModel {
  /** By the catalog id of the Kubernetes cluster. */
  grafana: Record<string, GrafanaSettings>;
}

export class CnpgPreferencesStore extends Common.Store.ExtensionStore<CnpgPreferencesModel> {
  grafana: Record<string, GrafanaSettings> = {};

  constructor() {
    super({ configName: "cnpg-preferences-store", defaults: { grafana: {} } });
    // A reference, replaced whole on every change: the host clones the model to send it to main, and a deep
    // observable would hand it proxies that cannot be cloned.
    makeObservable(this, { grafana: observableRef, setGrafana: action, fromStore: action });
  }

  /** Sets, or with an empty URL removes, the Grafana of one cluster. */
  setGrafana(clusterId: string, settings: GrafanaSettings): void {
    const { [clusterId]: _previous, ...others } = this.grafana;
    this.grafana = settings.url.trim() ? { ...others, [clusterId]: settings } : others;
  }

  fromStore({ grafana }: CnpgPreferencesModel): void {
    this.grafana = { ...(grafana ?? {}) };
  }

  toJSON(): CnpgPreferencesModel {
    return {
      grafana: Object.fromEntries(
        Object.entries(this.grafana).map(([id, { url, dashboardUid }]) => [id, { url, dashboardUid }]),
      ),
    };
  }
}
