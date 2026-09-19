# @freelensapp/cnpg-extension

<!-- markdownlint-disable MD013 -->

[![Home](https://img.shields.io/badge/%F0%9F%8F%A0-freelens.app-02a7a0)](https://freelens.app)
[![GitHub](https://img.shields.io/github/stars/freelensapp/freelens?style=flat&label=GitHub%20%E2%AD%90)](https://github.com/freelensapp/freelens)
[![DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/freelensapp/freelens-cnpg-extension)
[![Release](https://img.shields.io/github/v/release/freelensapp/freelens-cnpg-extension?display_name=tag&sort=semver)](https://github.com/freelensapp/freelens-cnpg-extension)
[![Integration tests](https://github.com/freelensapp/freelens-cnpg-extension/actions/workflows/integration-tests.yaml/badge.svg?branch=main)](https://github.com/freelensapp/freelens-cnpg-extension/actions/workflows/integration-tests.yaml)
[![npm](https://img.shields.io/npm/v/@freelensapp/cnpg-extension.svg)](https://www.npmjs.com/package/@freelensapp/cnpg-extension)

<!-- markdownlint-enable MD013 -->

## Overview

[Freelens](https://freelens.app) extension for
[CloudNativePG](https://cloudnative-pg.io), the Kubernetes operator for
PostgreSQL.

The goal of this extension is to be the most complete and usable graphical
interface for CloudNativePG: everything an operator needs to see, and later to
do, on PostgreSQL clusters managed by the operator, from the Kubernetes
resources down to the live state of the databases, inside the Freelens desktop
application and across every cluster it manages.

What is there today, all of it read-only:

- **Overview**: the health of every PostgreSQL cluster at a glance, with every
  tile and counter leading to the list or the drawer behind it.
- **PostgreSQL Clusters**: the list with a health summary (ready instances,
  primary, WAL archiving, last successful backup) and a drawer that tells the
  whole story of a cluster: instances and roles, replication, storage,
  certificates with their expiry, conditions, backups and the related pods,
  PVCs, services and secrets.
- **Backups and Scheduled Backups**: lists and drawers with the outcome of
  every backup and its reason, the coordinates needed to restore from it, the
  schedule as written and in words, and a backup history strip that shows at
  a glance how a cluster has been protected over time.
- **Live View**: what happens inside a cluster right now (replication
  topology and lag, sessions, database sizes, WAL and archiving, replication
  slots), read from the instances through the API server pod proxy. It needs
  the `get` verb on `pods/proxy` and nothing installed beyond the operator:
  no database credential is ever read, stored or asked for.
- **Open psql**: a `psql` session on the primary, or on the instance you pick,
  in a Freelens terminal tab.

### What the psql session is

"Open psql" writes one command into a terminal tab of Freelens, the same one
the `kubectl cnpg psql` plugin runs:
`kubectl exec -i -t -n <namespace> <pod> -c postgres -- psql -U postgres`.
It runs under your own kubeconfig and needs `pods/exec` on the instance pod.
**The session connects as the `postgres` superuser** over the local socket of
the instance, exactly as the upstream plugin does; on a standby it is a
read-only session. The extension itself never runs SQL and never sees a
credential: it composes the command from the namespace and the pod name,
and everything after that happens in your terminal.

Later milestones: Pooler, Database, DatabaseRole, Publication, Subscription,
ImageCatalog, ClusterImageCatalog, FailoverQuorum, Barman Cloud ObjectStore,
operator status and events timeline, write actions behind explicit
confirmation, creation forms, metrics charts. The roadmap and the
specifications live under `docs/` and are the single source of truth for
scope and progress.

> Status: early development, not yet released.

The extension is written from scratch under the MIT license and reads the
resources directly from the Kubernetes API through the Freelens extension
framework. Other CloudNativePG user interfaces are functional references only;
no code is copied from them.

## Requirements

- Kubernetes cluster with the CloudNativePG operator installed (the reviewed
  operator version is 1.30)
- Freelens >= 1.10.3

## Supported APIs

Planned coverage, in milestone order. Nothing is implemented yet.

### postgresql.cnpg.io/v1

<!-- markdownlint-disable MD013 -->

| Kind | Planned milestone | Notes |
| --- | --- | --- |
| `Cluster` | 0.1 | List with health summary, detail with instances, replication, storage, certificates, conditions, related objects |
| `Backup` | 0.1 | List and detail |
| `ScheduledBackup` | 0.1 | List and detail |
| `Pooler` | after 0.1 | |
| `Database` | after 0.1 | |
| `DatabaseRole` | after 0.1 | |
| `Publication` | after 0.1 | |
| `Subscription` | after 0.1 | |
| `ImageCatalog` | after 0.1 | |
| `ClusterImageCatalog` | after 0.1 | |
| `FailoverQuorum` | after 0.1 | |

### barmancloud.cnpg.io

| Kind | Planned milestone | Notes |
| --- | --- | --- |
| `ObjectStore` | after 0.1 | Barman Cloud plugin; the in-tree `barmanObjectStore` form is deprecated and is never generated by the extension |

<!-- markdownlint-enable MD013 -->

## Install

To install, open Freelens and go to Extensions (`ctrl`+`shift`+`E` or
`cmd`+`shift`+`E`), then search for and install
`@freelensapp/cnpg-extension`.

Alternatively, open the following URL in the browser to install directly:

[freelens://app/extensions/install/%40freelensapp%2Fcnpg-extension](freelens://app/extensions/install/%40freelensapp%2Fcnpg-extension)

## Build from the source

You can build the extension from this repository.

### Prerequisites

Use [NVM](https://github.com/nvm-sh/nvm),
[mise-en-place](https://mise.jdx.dev/), or
[windows-nvm](https://github.com/coreybutler/nvm-windows) to install the
required Node.js version.

From the root of this repository:

```sh
nvm install
# or
mise install
# or
winget install CoreyButler.NVMforWindows
nvm install 24.15.0
nvm use 24.15.0
```

Install pnpm:

```sh
corepack install
# or
curl -fsSL https://get.pnpm.io/install.sh | sh -
# or
winget install pnpm.pnpm
```

### Build extension

```sh
pnpm i
pnpm build
pnpm pack
```

One script to build and pack the extension for testing:

```sh
pnpm pack:dev
```

### Install built extension

The tarball will be placed in the current directory. In Freelens, navigate
to the Extensions page and provide the path to the tarball, or drag and
drop the `.tgz` file into the Freelens window.

### Check code statically

```sh
pnpm lint:check
```

or

```sh
pnpm trunk:check
```

and

```sh
pnpm build
pnpm knip:check
```

### Testing the extension with unpublished Freelens

In the Freelens working repository:

```sh
rm -f *.tgz
pnpm i
pnpm build
pnpm pack -r
```

Then in the extension repository:

```sh
echo "overrides:" >> pnpm-workspace.yaml
for i in ../freelens/*.tgz; do
  name=$(tar zxOf $i package/package.json | yq -r .name)
  echo "  \"$name\": $i" >> pnpm-workspace.yaml
done

pnpm clean:node_modules
pnpm build
```

## License

Copyright (c) 2025-2026 Freelens Authors.

[MIT License](https://opensource.org/licenses/MIT)
