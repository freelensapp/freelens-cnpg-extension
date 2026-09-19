# SPEC-0010: Image Catalogs and Cluster Image Catalogs, lists and details (read-only)

- **Status:** Implemented
- **Milestone:** `M3` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator sees which PostgreSQL images each catalog offers per major
version, and which clusters take their image from it: the question before
every minor upgrade rolled out by editing a catalog is "who moves when I
change this line".

## Upstream reference

- `ImageCatalog` (namespaced) and `ClusterImageCatalog` (cluster scoped) of
  `postgresql.cnpg.io/v1`: `spec.images[]` with `major` and `image`, and in
  1.30 the `extensions[]` of an image and the catalog's `componentImages[]`.
  Neither kind has a status.
- A cluster points at a catalog with `spec.imageCatalogRef` (`kind`, `name`,
  `major`); a pooler may do the same for its PgBouncer image
  (`spec.pgbouncer.imageCatalogRef`, with a `key` into `componentImages`).
  The image a cluster actually runs is in `status.image`. Functional
  reference only.

## Scope

Included: the typed models of the two kinds, one list page for each in a new
"Images" sidebar group, one drawer component shared by both, the referring
clusters and poolers, the door from the Cluster drawer (the catalog
reference becomes a link). Excluded: editing a catalog, comparing a catalog
with a registry, image vulnerability data.

## Design

### Standard or ad hoc view, and why

Standard. Two kinds with the same shape get the same columns and the same
drawer; the cluster scoped one has no Namespace column, which is the one
deviation from the column grammar the host itself makes for cluster scoped
kinds.

### Model and pure module

`src/renderer/api/cnpg/image-catalog-v1.ts` (both kinds, the cluster scoped
one with `namespaced = false`). `src/renderer/components/image-catalogs.ts`
(pure, tested):

- `catalogMajors(catalog)`: the majors offered, descending, each with its
  image, its tag (the part after the last colon, or the digest shortened) and
  its extension names;
- `clustersOfCatalog(catalog, clusters)`: the clusters whose
  `imageCatalogRef` names this catalog (kind and name, and the same namespace
  for the namespaced kind), each with the major it asks for, the image the
  catalog offers for it, the image the cluster runs, and a state: `Aligned`
  (they are equal), `Rolling out` (they differ: the catalog changed and the
  cluster is following, or waits for a supervised update), `Missing major`
  (the catalog has no entry for the major the cluster asks for, which blocks
  the cluster: error);
- `classifyCatalog(catalog, clusters)`: `In use`, `Unused`, `Missing major`.

### Lists

`Name | Namespace | Majors | Latest | Images | Clusters | Condition | Status |
Age` (without Namespace for the cluster scoped kind). Majors reads `18, 17,
16`; Latest is the image of the highest major, truncated with tooltip.
`tableId`s `cnpgImageCatalogsTable` and `cnpgClusterImageCatalogsTable`;
menu ids `cnpg-images`, `cnpg-images-imagecatalogs`,
`cnpg-images-clusterimagecatalogs`.

### Drawer (`src/renderer/details/image-catalog-details-v1.tsx`)

1. **Catalog**: condition and status, scope (namespace or whole cluster).
2. **Images**: nested table major, image (selectable text), extensions.
3. **Component images**: key and image, hidden when empty.
4. **Clusters**: nested table cluster (link), namespace, major, image in the
   catalog, image running, state.
5. **Poolers**: the poolers that take their PgBouncer image from it, with the
   key, hidden when none.

### Doors

Cluster drawer, PostgreSQL section: "Image catalog" row with the kind, the
name as a link to its drawer and the major.

### Non-happy states

As every list. A reference to a catalog that does not exist shows in the
Cluster drawer as plain text with a tooltip; the operator already reports it
in the cluster phase, which the health model classifies Failed.

### Safety

Reads only.

## Tests (non-regression list)

- Unit: `image-catalogs.test.ts` (majors order, tag and digest shortening,
  the three cluster states, namespace rule for the two kinds, poolers by key,
  classification).
- E2E, with fixtures `e2e-images` (ImageCatalog, majors 17 and 18) and
  `e2e-cluster-images` (ClusterImageCatalog) and `e2e-hibernated` created
  from `e2e-images` major 18: both lists, the drawer of `e2e-images` with
  `e2e-hibernated` among its clusters, the link from the Cluster drawer.
- Manual verification: the M3 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M3 at the
  milestone review.
- Implementation notes: one factory builds both list pages and one component
  is the drawer of both kinds. The images table shows the image without its
  registry and path (`postgresql:18.4-system-trixie`), the part that tells two
  lines of a catalog apart, with the full reference in the tooltip: the full
  reference was cut exactly at the tag. The column grammar check of the E2E
  suite learned that a cluster scoped kind has no Namespace column.
- On a cluster that already exists, a `Cluster` cannot move from the image the
  webhook defaulted into `spec.imageName` to an `imageCatalogRef` by applying
  the fixture again (the two are mutually exclusive): locally the fixture
  cluster was deleted and created again; a fresh E2E cluster creates it from
  the catalog.
- The poolers that take their PgBouncer image from a catalog are listed by
  SPEC-0012, which brings the `Pooler` model.
- Merged with #28 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `c4f2481`. The manual verification above is part of the M3
  milestone review: the status moves to Verified when its result is recorded
  here.
