/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Klio Configurations list (SPEC-0036): the PluginConfiguration objects of
// Klio, an optional CNPG-I backup plugin, read-only, with the cluster each one
// is for and whether that cluster uses it.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { PluginConfiguration } from "../api/klio/plugin-configuration-v1alpha1";
import { withErrorPage } from "../components/error-page";
import { klioFacts } from "../components/klio";
import { useReferenceStores } from "../components/reference-loader";

import type { PluginConfigurationApi } from "../api/klio/plugin-configuration-v1alpha1";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

function clusters(): Cluster[] {
  return (maybe(() => Cluster.getStore<Cluster>())?.items ?? []) as Cluster[];
}

const facts = (object: PluginConfiguration) => klioFacts(object, clusters());

const sortingCallbacks = {
  name: (object: PluginConfiguration) => object.getName(),
  namespace: (object: PluginConfiguration) => object.getNs() ?? "",
  cluster: (object: PluginConfiguration) => object.spec?.clusterName ?? "",
  mode: (object: PluginConfiguration) => facts(object).mode,
  server: (object: PluginConfiguration) => object.spec?.serverAddress ?? "",
  condition: (object: PluginConfiguration) => facts(object).state,
  age: (object: PluginConfiguration) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster" },
  { title: "Mode", sortBy: "mode" },
  { title: "Server", sortBy: "server" },
  { title: "Condition", sortBy: "condition" },
  { title: "Age", sortBy: "age" },
];

export interface KlioConfigurationsPageProps {
  extension: Renderer.LensExtension;
}

export const KlioConfigurationsPage = observer((props: KlioConfigurationsPageProps) =>
  withErrorPage(props, () => {
    const store = PluginConfiguration.getStore<PluginConfiguration>();
    useReferenceStores([{ label: Cluster.crd.plural, store: maybe(() => Cluster.getStore<Cluster>()) }]);
    return (
      <KubeObjectListLayout<PluginConfiguration, PluginConfigurationApi>
        tableId="cnpgKlioConfigurationsTable"
        className="cnpgKlioConfigurations"
        store={store}
        sortingCallbacks={sortingCallbacks}
        searchFilters={[(object: PluginConfiguration) => object.getSearchFields()]}
        renderHeaderTitle={PluginConfiguration.crd.title}
        renderTableHeader={renderTableHeader}
        renderTableContents={(object: PluginConfiguration) => {
          const klio = facts(object);
          return [
            <WithTooltip key="name">{object.getName()}</WithTooltip>,
            <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
            <WithTooltip
              key="cluster"
              tooltip={klio.unused ? "No cluster of the namespace refers to this configuration" : undefined}
            >
              {`${klio.cluster ?? "N/A"}${klio.unused ? " (not used)" : ""}`}
            </WithTooltip>,
            <span key="mode">{klio.mode}</span>,
            <WithTooltip key="server">{klio.server ?? "N/A"}</WithTooltip>,
            <Badge key="condition" className={klio.className} label={klio.state} tooltip={klio.reason} />,
            <KubeObjectAge key="age" object={object} />,
          ];
        }}
      />
    );
  }),
);
