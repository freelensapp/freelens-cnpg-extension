/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Open in Grafana" (SPEC-0039): the CloudNativePG dashboard of a cluster, in
// the browser, with the Grafana set for the Kubernetes cluster of the moment.
// Without one, the drawer shows nothing and the Live View says where to set it.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { CnpgPreferencesStore } from "../../common/preferences-store";
import { maybe } from "../../common/utils";
import { grafanaDashboardUrl, grafanaRange } from "./grafana";

const { observer } = MobxReact;

const {
  Component: { Icon },
} = Renderer;

export interface GrafanaLinkProps {
  extension: Renderer.LensExtension;
  namespace: string;
  cluster: string;
  /** A range of the Live View (`5m`, `15m`, `1h`, `all`), and when it opened. */
  range?: string;
  openedAt?: number;
  /** Says where to set the URL when there is none, instead of showing nothing. */
  explainWhenMissing?: boolean;
}

/** The dashboard URL for a cluster of the Kubernetes cluster of the moment; undefined when none is set. */
export function grafanaUrlFor(
  namespace: string,
  cluster: string,
  range?: string,
  openedAt?: number,
): string | undefined {
  const active = maybe(() => Renderer.Catalog.getActiveCluster());
  const preferences = maybe(() => CnpgPreferencesStore.getInstanceOrCreate<CnpgPreferencesStore>());
  const settings = active ? preferences?.grafana[active.id] : undefined;
  return grafanaDashboardUrl(settings, namespace, cluster, grafanaRange(range, openedAt));
}

export const GrafanaLink = observer(
  ({ extension, namespace, cluster, range, openedAt, explainWhenMissing = false }: GrafanaLinkProps) => {
    const url = grafanaUrlFor(namespace, cluster, range, openedAt);
    if (!url) {
      return explainWhenMissing ? (
        <a
          href="#preferences"
          data-testid="cnpg-grafana-missing"
          title="Set the Grafana of this Kubernetes cluster in the preferences of the extension"
          onClick={(event) => {
            event.preventDefault();
            extension.navigateToPreferences();
          }}
        >
          Grafana: set its URL in the preferences
        </a>
      ) : null;
    }
    return (
      <a
        href={url}
        data-testid="cnpg-grafana-link"
        title={url}
        onClick={(event) => {
          // The host opens window.open targets in the browser.
          event.preventDefault();
          event.stopPropagation();
          window.open(url, "_blank", "noopener");
        }}
      >
        Open in Grafana <Icon small material="open_in_new" />
      </a>
    );
  },
);
