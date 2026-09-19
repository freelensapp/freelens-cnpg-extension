/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Image Catalogs and the Cluster Image Catalogs lists (SPEC-0010). The two
// kinds have the same shape, so one factory builds both pages; the cluster
// scoped one has no Namespace column, the deviation from the column grammar
// the host itself makes for cluster scoped kinds.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import { withErrorPage } from "../components/error-page";
import { catalogMajors, classifyCatalog, clustersOfCatalog } from "../components/image-catalogs";
import { useReferenceStores } from "../components/reference-loader";
import styles from "./image-catalogs-page.module.scss";
import stylesInline from "./image-catalogs-page.module.scss?inline";

import type { AnyImageCatalog, ImageCatalogStore } from "../api/cnpg/image-catalog-v1";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const notAvailable = "N/A";

function clusters(): Cluster[] {
  return (maybe(() => Cluster.getStore<Cluster>())?.items ?? []) as Cluster[];
}

const sortingCallbacks = {
  name: (object: AnyImageCatalog) => object.getName(),
  namespace: (object: AnyImageCatalog) => object.getNs() ?? "",
  majors: (object: AnyImageCatalog) => catalogMajors(object)[0]?.major ?? 0,
  latest: (object: AnyImageCatalog) => catalogMajors(object)[0]?.image ?? "",
  images: (object: AnyImageCatalog) => catalogMajors(object).length,
  clusters: (object: AnyImageCatalog) => clustersOfCatalog(object, clusters()).length,
  condition: (object: AnyImageCatalog) => classifyCatalog(object, clusters()).state,
  status: (object: AnyImageCatalog) => classifyCatalog(object, clusters()).reason,
  age: (object: AnyImageCatalog) => object.getCreationTimestamp(),
};

type Header = { title: string; sortBy: keyof typeof sortingCallbacks; className?: string };

function searchFields(object: AnyImageCatalog): string[] {
  const majors = catalogMajors(object);
  return [
    ...majors.map((entry) => entry.image),
    ...majors.map((entry) => `PostgreSQL ${entry.major}`),
    classifyCatalog(object, clusters()).state,
    ...clustersOfCatalog(object, clusters()).map((follower) => follower.name),
  ];
}

export interface ImageCatalogsPageProps {
  extension: Renderer.LensExtension;
}

function createCatalogsPage(kubeObjectClass: typeof ImageCatalog | typeof ClusterImageCatalog, tableId: string) {
  const namespaced = kubeObjectClass.namespaced;
  const headers: Header[] = [
    { title: "Name", sortBy: "name" },
    ...(namespaced ? [{ title: "Namespace", sortBy: "namespace" } as Header] : []),
    { title: "Majors", sortBy: "majors", className: styles.majors },
    { title: "Latest", sortBy: "latest", className: styles.latest },
    { title: "Images", sortBy: "images", className: styles.images },
    { title: "Clusters", sortBy: "clusters", className: styles.clusters },
    { title: "Condition", sortBy: "condition", className: styles.condition },
    { title: "Status", sortBy: "status", className: styles.status },
    { title: "Age", sortBy: "age", className: styles.age },
  ];

  return observer((props: ImageCatalogsPageProps) =>
    withErrorPage(props, () => {
      // The two kinds have the same shape: the layout is typed over the namespaced
      // one, and the cluster scoped store is handed to it as such.
      const store = (
        namespaced ? ImageCatalog.getStore<ImageCatalog>() : ClusterImageCatalog.getStore<ClusterImageCatalog>()
      ) as ImageCatalogStore;
      const clusterStore = maybe(() => Cluster.getStore<Cluster>());

      // The Clusters column and the condition derive from the clusters that
      // follow the catalog: the loader keeps them loaded while the page is mounted.
      useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

      return (
        <>
          <style>{stylesInline}</style>
          <KubeObjectListLayout
            tableId={tableId}
            className={styles.page}
            store={store}
            sortingCallbacks={sortingCallbacks}
            searchFilters={[(object: AnyImageCatalog) => object.getSearchFields(), searchFields]}
            renderHeaderTitle={kubeObjectClass.crd.title}
            renderTableHeader={headers}
            renderTableContents={(object: AnyImageCatalog) => {
              const all = (clusterStore?.items ?? []) as Cluster[];
              const majors = catalogMajors(object);
              const followers = clustersOfCatalog(object, all);
              const health = classifyCatalog(object, all);

              return [
                <WithTooltip key="name">{object.getName()}</WithTooltip>,
                ...(namespaced ? [<NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />] : []),
                <WithTooltip key="majors">{majors.map((entry) => entry.major).join(", ") || notAvailable}</WithTooltip>,
                <WithTooltip key="latest" tooltip={majors[0]?.image}>
                  {majors[0]?.tag ?? notAvailable}
                </WithTooltip>,
                <span key="images">{majors.length}</span>,
                <WithTooltip
                  key="clusters"
                  tooltip={
                    followers.length > 0
                      ? followers.map((follower) => `${follower.namespace}/${follower.name}`).join(", ")
                      : "No cluster takes its image from here"
                  }
                >
                  {String(followers.length)}
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
}

export const ImageCatalogsPage = createCatalogsPage(ImageCatalog, "cnpgImageCatalogsTable");
export const ClusterImageCatalogsPage = createCatalogsPage(ClusterImageCatalog, "cnpgClusterImageCatalogsTable");
