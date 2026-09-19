/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Page and menu identifiers of the extension (SPEC-0003 "Sidebar", SPEC-0004
// "Placement", SPEC-0005 "Sidebar"), shared by the registrations in index.tsx,
// the pages that navigate between them and the E2E helpers.

export const ROOT_MENU_ID = "cnpg";
export const OVERVIEW_GROUP_ID = "cnpg-overview";
export const OVERVIEW_PAGE_ID = "cnpg-overview";
export const CLUSTERS_GROUP_ID = "cnpg-clusters";
export const CLUSTERS_PAGE_ID = "cnpg-clusters-clusters";
export const BACKUPS_GROUP_ID = "cnpg-backups";
export const BACKUPS_PAGE_ID = "cnpg-backups-backups";
export const SCHEDULED_BACKUPS_PAGE_ID = "cnpg-backups-scheduledbackups";

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
