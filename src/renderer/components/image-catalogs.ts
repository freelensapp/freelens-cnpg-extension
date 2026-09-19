/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the image catalogs (SPEC-0010): what a catalog offers per
// major version, which clusters take their image from it, and whether each of
// them runs the image the catalog offers. The question it answers is the one
// asked before editing a catalog: "who moves when I change this line".

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { AnyImageCatalog, CatalogKind } from "../api/cnpg/image-catalog-v1";
import type { HostStatusClass } from "./cluster-health";

export interface CatalogMajor {
  major: number;
  image: string;
  /** The tag, or the digest shortened: what tells two lines of a catalog apart at a glance. */
  tag: string;
  extensions: string[];
}

/** `repo/name:tag` to `tag`, `repo/name@sha256:abcdef...` to `sha256:abcdef012345`. */
export function imageTag(image: string): string {
  const at = image.lastIndexOf("@");
  if (at >= 0) {
    const digest = image.slice(at + 1);
    const colon = digest.indexOf(":");
    return colon >= 0 ? `${digest.slice(0, colon)}:${digest.slice(colon + 1, colon + 13)}` : digest;
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : "latest";
}

/** The image without its registry and path: `ghcr.io/org/postgresql:18.4` to `postgresql:18.4`, the part that tells images apart. */
export function imageShort(image: string): string {
  return image.slice(image.lastIndexOf("/") + 1);
}

/** The majors a catalog offers, the highest first. */
export function catalogMajors(catalog: AnyImageCatalog): CatalogMajor[] {
  return [...(catalog.spec?.images ?? [])]
    .filter((entry) => typeof entry.major === "number" && Boolean(entry.image))
    .sort((a, b) => b.major - a.major)
    .map((entry) => ({
      major: entry.major,
      image: entry.image,
      tag: imageTag(entry.image),
      extensions: (entry.extensions ?? []).map((extension) => extension.name ?? "").filter(Boolean),
    }));
}

export type FollowerState = "Aligned" | "Rolling out" | "Missing major";

export interface CatalogFollower {
  cluster: Cluster;
  name: string;
  namespace: string;
  major: number;
  /** The image the catalog offers for the major the cluster asks for. */
  offered?: string;
  /** The image the cluster runs, from its status. */
  running?: string;
  state: FollowerState;
}

function kindOf(catalog: AnyImageCatalog): CatalogKind {
  return catalog.kind === "ClusterImageCatalog" ? "ClusterImageCatalog" : "ImageCatalog";
}

/** The clusters whose `imageCatalogRef` names this catalog: kind, name and, for the namespaced kind, namespace. */
export function clustersOfCatalog(catalog: AnyImageCatalog, clusters: readonly Cluster[]): CatalogFollower[] {
  const kind = kindOf(catalog);
  const name = catalog.metadata?.name;
  const namespace = catalog.metadata?.namespace;
  const majors = catalogMajors(catalog);
  const followers: CatalogFollower[] = [];

  for (const cluster of clusters) {
    const ref = cluster.spec?.imageCatalogRef;
    if (!ref || ref.name !== name || (ref.kind || "ImageCatalog") !== kind) continue;
    if (kind === "ImageCatalog" && cluster.metadata?.namespace !== namespace) continue;

    const offered = majors.find((entry) => entry.major === ref.major)?.image;
    const running = cluster.status?.image || undefined;
    let state: FollowerState = "Aligned";
    if (!offered) state = "Missing major";
    else if (running !== offered) state = "Rolling out";
    followers.push({
      cluster,
      name: cluster.metadata?.name ?? "",
      namespace: cluster.metadata?.namespace ?? "",
      major: ref.major,
      offered,
      running,
      state,
    });
  }

  const rank: Record<FollowerState, number> = { "Missing major": 0, "Rolling out": 1, Aligned: 2 };
  return followers.sort(
    (a, b) => rank[a.state] - rank[b.state] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
}

export type CatalogState = "In use" | "Unused" | "Missing major";

export interface CatalogHealth {
  state: CatalogState;
  label: CatalogState;
  className: HostStatusClass;
  reason: string;
}

export function classifyCatalog(catalog: AnyImageCatalog, clusters: readonly Cluster[]): CatalogHealth {
  const followers = clustersOfCatalog(catalog, clusters);
  const blocked = followers.filter((follower) => follower.state === "Missing major");
  if (blocked.length > 0) {
    return {
      state: "Missing major",
      label: "Missing major",
      className: "error",
      reason: blocked
        .map((follower) => `${follower.name} asks for PostgreSQL ${follower.major}, which the catalog does not offer`)
        .join("; "),
    };
  }
  if (followers.length === 0) {
    return { state: "Unused", label: "Unused", className: "info", reason: "No cluster takes its image from here" };
  }
  const rolling = followers.filter((follower) => follower.state === "Rolling out").length;
  return {
    state: "In use",
    label: "In use",
    className: "success",
    reason:
      `${followers.length} cluster${followers.length === 1 ? "" : "s"}` +
      (rolling > 0 ? `, ${rolling} not yet on the image of the catalog` : ", all on the image of the catalog"),
  };
}
