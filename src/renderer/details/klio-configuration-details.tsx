/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The drawer of a Klio PluginConfiguration (SPEC-0036), read-only: the
// cluster it is for, whether that cluster uses it, its server and its
// secrets, the tiers and the WAL prefetch.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { PluginConfiguration } from "../api/klio/plugin-configuration-v1alpha1";
import { withErrorPage } from "../components/error-page";
import { klioFacts } from "../components/klio";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, WithTooltip },
  K8sApi: { secretsStore },
} = Renderer;

export interface KlioConfigurationDetailsProps extends Renderer.Component.KubeObjectDetailsProps<PluginConfiguration> {
  extension: Renderer.LensExtension;
}

export const KlioConfigurationDetails = observer((props: KlioConfigurationDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;
    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== PluginConfiguration.kind) return <></>;

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: "secrets", store: secretsStore, namespaces: [namespace] },
    ]);
    const klio = klioFacts(object, (clusterStore?.items ?? []) as Cluster[]);
    const spec = object.spec;

    return (
      <>
        <DrawerTitle>Klio</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={klio.className} label={klio.state} tooltip={klio.reason} />
        </DrawerItem>
        <DrawerItem name="Cluster">
          {klio.cluster ? <StoreLink inline store={clusterStore} name={klio.cluster} namespace={namespace} /> : "N/A"}
        </DrawerItem>
        <DrawerItem name="Used by">
          {klio.unused
            ? "No cluster of the namespace refers to it (spec.plugins[].parameters.pluginConfigurationRef)"
            : klio.usedBy.join(", ")}
        </DrawerItem>
        <DrawerItem name="Mode">
          <WithTooltip tooltip="read-only: the cluster restores from Klio and writes nothing to it">
            {klio.mode}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Server">
          <WithTooltip tooltip="Port 51515 for base backups, 52000 for WAL streaming">
            {klio.server ?? "N/A"}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Client certificate" hidden={!spec?.clientSecretName}>
          <StoreLink inline store={secretsStore} name={spec?.clientSecretName} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Server certificate" hidden={!spec?.serverSecretName}>
          <StoreLink inline store={secretsStore} name={spec?.serverSecretName} namespace={namespace} />
        </DrawerItem>
        {klio.tiers.map((tier) => (
          <DrawerItem key={tier.tier} name={tier.tier}>
            {tier.words}
          </DrawerItem>
        ))}
        <DrawerItem name="WAL prefetch" hidden={!spec?.walPrefetch}>
          {`${spec?.walPrefetch?.count ?? "N/A"} files, ${spec?.walPrefetch?.maxConcurrentDownloads ?? "N/A"} downloads at a time`}
        </DrawerItem>
      </>
    );
  }),
);
