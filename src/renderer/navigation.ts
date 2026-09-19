/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Page and menu identifiers of the extension (SPEC-0003 "Sidebar", SPEC-0004
// "Placement", SPEC-0005 "Sidebar", SPEC-0013 "List"), shared by the registrations in index.tsx,
// the pages that navigate between them and the E2E helpers.

export const ROOT_MENU_ID = "cnpg";
export const OVERVIEW_GROUP_ID = "cnpg-overview";
export const OVERVIEW_PAGE_ID = "cnpg-overview";
export const CLUSTERS_GROUP_ID = "cnpg-clusters";
export const CLUSTERS_PAGE_ID = "cnpg-clusters-clusters";
export const LIVE_PAGE_ID = "cnpg-clusters-live";
export const LOGS_PAGE_ID = "cnpg-clusters-logs";
export const FAILOVER_QUORUMS_PAGE_ID = "cnpg-clusters-failoverquorums";
export const BACKUPS_GROUP_ID = "cnpg-backups";
export const BACKUPS_PAGE_ID = "cnpg-backups-backups";
export const SCHEDULED_BACKUPS_PAGE_ID = "cnpg-backups-scheduledbackups";
export const OBJECT_STORES_PAGE_ID = "cnpg-backups-objectstores";
export const POOLING_GROUP_ID = "cnpg-pooling";
export const POOLERS_PAGE_ID = "cnpg-pooling-poolers";
export const DATABASES_GROUP_ID = "cnpg-databases";
export const DATABASES_PAGE_ID = "cnpg-databases-databases";
export const DATABASE_ROLES_PAGE_ID = "cnpg-databases-databaseroles";
export const PUBLICATIONS_PAGE_ID = "cnpg-databases-publications";
export const SUBSCRIPTIONS_PAGE_ID = "cnpg-databases-subscriptions";
export const IMAGES_GROUP_ID = "cnpg-images";
export const IMAGE_CATALOGS_PAGE_ID = "cnpg-images-imagecatalogs";
export const CLUSTER_IMAGE_CATALOGS_PAGE_ID = "cnpg-images-clusterimagecatalogs";

/**
 * The URL of one of the extension's pages. The host mounts them under
 * `/extension/<name with @ dropped and / as -->/<pageId>`, and the list layout
 * keeps its search box in the global `search` query parameter, so a door can
 * land on a filtered list. Navigation from an extension page goes through
 * links to these URLs (the M1 lesson: `navigate` has no effect from there).
 */
export function extensionPageUrl(extensionName: string, pageId: string, search?: string): string {
  const base = `/extension/${extensionName.replace(/^@/, "").replace(/\//g, "--")}/${pageId}`;
  return search ? `${base}?search=${encodeURIComponent(search)}` : base;
}

/** Name of the query parameter that carries the cluster of the Live View (SPEC-0006 "Placement and addressing"). */
export const LIVE_CLUSTER_PARAM = "cluster";

/** The Live View of a cluster: the cluster travels in the URL, so every door lands on the right one. */
export function liveViewUrl(extensionName: string, namespace?: string, name?: string): string {
  const base = extensionPageUrl(extensionName, LIVE_PAGE_ID);
  return namespace && name ? `${base}?${LIVE_CLUSTER_PARAM}=${encodeURIComponent(`${namespace}/${name}`)}` : base;
}

/** Name of the query parameter that narrows the Logs page to one instance (SPEC-0018). */
export const LOGS_INSTANCE_PARAM = "instance";

/** The Logs of a cluster, or of one of its instances: both travel in the URL. */
export function logsUrl(extensionName: string, namespace?: string, name?: string, instance?: string): string {
  const base = extensionPageUrl(extensionName, LOGS_PAGE_ID);
  if (!namespace || !name) return base;
  const query = `${LIVE_CLUSTER_PARAM}=${encodeURIComponent(`${namespace}/${name}`)}`;
  return instance ? `${base}?${query}&${LOGS_INSTANCE_PARAM}=${encodeURIComponent(instance)}` : `${base}?${query}`;
}
