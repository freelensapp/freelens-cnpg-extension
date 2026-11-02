/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The link to the team's Grafana (SPEC-0039): the CloudNativePG dashboard of
// one cluster, over the range the Live View shows. Pure: a link only, the
// extension sends no request to Grafana.

import { DEFAULT_DASHBOARD_UID } from "../../common/preferences-store";

import type { GrafanaSettings } from "../../common/preferences-store";

/** The base URL as typed, checked: an http or https URL without query or fragment; the reason otherwise. */
export function checkGrafanaUrl(text: string): { url?: string; problem?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { problem: "Not a URL: write it as https://grafana.example.com" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { problem: "Only http and https URLs open in the browser" };
  }
  if (parsed.username || parsed.password) {
    return { problem: "No credentials in the URL: Grafana asks for them in the browser" };
  }
  if (parsed.search || parsed.hash)
    return { problem: "The base URL only: the extension adds the dashboard and its variables" };
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}

/** The Grafana time range of a range of the Live View: relative, or from the time the view opened. */
export function grafanaRange(range: string | undefined, openedAt?: number): { from: string; to: string } {
  if (range === "all" && openedAt !== undefined) return { from: String(Math.floor(openedAt)), to: "now" };
  return { from: `now-${range && /^\d+[smhd]$/.test(range) ? range : "1h"}`, to: "now" };
}

/** The dashboard of one cluster; undefined without a valid URL for its Kubernetes cluster. */
export function grafanaDashboardUrl(
  settings: GrafanaSettings | undefined,
  namespace: string,
  cluster: string,
  range: { from: string; to: string } = grafanaRange(undefined),
): string | undefined {
  const base = settings ? checkGrafanaUrl(settings.url).url : undefined;
  if (!base) return undefined;
  const uid = settings?.dashboardUid.trim() || DEFAULT_DASHBOARD_UID;
  const query = new URLSearchParams({
    "var-namespace": namespace,
    "var-cluster": cluster,
    from: range.from,
    to: range.to,
  });
  return `${base}/d/${encodeURIComponent(uid)}?${query.toString()}`;
}
