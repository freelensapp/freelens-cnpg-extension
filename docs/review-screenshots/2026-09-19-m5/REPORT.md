# Pre-review pass

- Date: 2026-09-19T15:28:26.748Z
- Cluster: cnpg-e2e, operator image ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0
- Verdict: every automated check passed

## Checks

| Check | Outcome |
| --- | --- |
| Every page and drawer renders on the dark theme | passed |
| PostgreSQL Clusters: column grammar of DESIGN.md section 1 | passed |
| PostgreSQL Clusters: no empty cell, a missing value reads "N/A" | passed |
| PostgreSQL Clusters: no link nested in a link | passed |
| PostgreSQL Clusters: no authored color in inline styles | passed |
| Backups: column grammar of DESIGN.md section 1 | passed |
| Backups: no empty cell, a missing value reads "N/A" | passed |
| Backups: no link nested in a link | passed |
| Backups: no authored color in inline styles | passed |
| Scheduled Backups: column grammar of DESIGN.md section 1 | passed |
| Scheduled Backups: no empty cell, a missing value reads "N/A" | passed |
| Scheduled Backups: no link nested in a link | passed |
| Scheduled Backups: no authored color in inline styles | passed |
| Object Stores: column grammar of DESIGN.md section 1 | passed |
| Object Stores: no empty cell, a missing value reads "N/A" | passed |
| Object Stores: no link nested in a link | passed |
| Object Stores: no authored color in inline styles | passed |
| Poolers: column grammar of DESIGN.md section 1 | passed |
| Poolers: no empty cell, a missing value reads "N/A" | passed |
| Poolers: no link nested in a link | passed |
| Poolers: no authored color in inline styles | passed |
| Image Catalogs: column grammar of DESIGN.md section 1 | passed |
| Image Catalogs: no empty cell, a missing value reads "N/A" | passed |
| Image Catalogs: no link nested in a link | passed |
| Image Catalogs: no authored color in inline styles | passed |
| Failover Quorums: column grammar of DESIGN.md section 1 | passed |
| Failover Quorums: no empty cell, a missing value reads "N/A" | passed |
| Failover Quorums: no link nested in a link | passed |
| Failover Quorums: no authored color in inline styles | passed |
| Databases: column grammar of DESIGN.md section 1 | passed |
| Databases: no empty cell, a missing value reads "N/A" | passed |
| Databases: no link nested in a link | passed |
| Databases: no authored color in inline styles | passed |
| Database Roles: column grammar of DESIGN.md section 1 | passed |
| Database Roles: no empty cell, a missing value reads "N/A" | passed |
| Database Roles: no link nested in a link | passed |
| Database Roles: no authored color in inline styles | passed |
| Publications: column grammar of DESIGN.md section 1 | passed |
| Publications: no empty cell, a missing value reads "N/A" | passed |
| Publications: no link nested in a link | passed |
| Publications: no authored color in inline styles | passed |
| Subscriptions: column grammar of DESIGN.md section 1 | passed |
| Subscriptions: no empty cell, a missing value reads "N/A" | passed |
| Subscriptions: no link nested in a link | passed |
| Subscriptions: no authored color in inline styles | passed |
| Overview: no link nested in a link | passed |
| Overview: no authored color in inline styles | passed |
| Live View: no link nested in a link | passed |
| Live View: no authored color in inline styles | passed |
| Live View: declares its intervals and offers pause and refresh as buttons | passed |
| Live View: the primary it draws is the one Cluster.status names | passed |
| Live View: the LSN of the primary lies between two answers of the instance manager | passed |
| Cluster drawer: the last successful backup is the latest completed Backup object | passed |
| Logs: no link nested in a link | passed |
| Logs: no authored color in inline styles | passed |
| Timeline: no link nested in a link | passed |
| Timeline: no authored color in inline styles | passed |
| Operator: no link nested in a link | passed |
| Operator: no authored color in inline styles | passed |
| Cluster drawer and Operator: the leaders shown are the holders of the leases | passed |
| Timeline: a completed backup sits at the time its Backup object stopped | passed |
| Logs: the rows of an instance are the lines its pod wrote | passed |
| Databases: every condition agrees with what the operator wrote in the status | passed |
| Subscription drawer: the slot it shows is the one the publisher's exporter reports | passed |
| Every page and drawer renders on the light theme | passed |
| No console error and no failed request | passed |

## Screenshots

- dark-overview.png
- dark-clusters.png
- dark-cluster-drawer.png
- dark-cluster-drawer-backups.png
- dark-live-view.png
- dark-live-view-tiles.png
- dark-backups.png
- dark-backup-drawer.png
- dark-scheduled-backups.png
- dark-scheduled-backup-drawer.png
- dark-object-stores.png
- dark-object-store-drawer.png
- dark-poolers.png
- dark-pooler-drawer.png
- dark-databases.png
- dark-database-drawer.png
- dark-database-roles.png
- dark-database-role-drawer.png
- dark-publications.png
- dark-publication-drawer.png
- dark-subscriptions.png
- dark-subscription-drawer.png
- dark-subscription-drawer-right-now.png
- dark-cluster-drawer-declarative.png
- dark-cluster-drawer-lease.png
- dark-logs.png
- dark-timeline.png
- dark-operator.png
- dark-operator-plugins-and-kinds.png
- dark-image-catalogs.png
- dark-image-catalog-drawer.png
- dark-cluster-image-catalogs.png
- dark-failover-quorums.png
- dark-failover-quorum-drawer.png
- light-overview.png
- light-clusters.png
- light-cluster-drawer.png
- light-cluster-drawer-backups.png
- light-live-view.png
- light-live-view-tiles.png
- light-backups.png
- light-backup-drawer.png
- light-scheduled-backups.png
- light-scheduled-backup-drawer.png
- light-object-stores.png
- light-object-store-drawer.png
- light-poolers.png
- light-pooler-drawer.png
- light-databases.png
- light-database-drawer.png
- light-database-roles.png
- light-database-role-drawer.png
- light-publications.png
- light-publication-drawer.png
- light-subscriptions.png
- light-subscription-drawer.png
- light-subscription-drawer-right-now.png
- light-cluster-drawer-declarative.png
- light-cluster-drawer-lease.png
- light-logs.png
- light-timeline.png
- light-operator.png
- light-operator-plugins-and-kinds.png
- light-image-catalogs.png
- light-image-catalog-drawer.png
- light-cluster-image-catalogs.png
- light-failover-quorums.png
- light-failover-quorum-drawer.png

## For human judgment

- Overview: is the tile density right on a laptop screen, and does the order by urgency match what you would look at first?
- Backup history strip: does it tell the protection story of a cluster at a glance (gaps, failures, next run)?
- Live View: is the topology still readable with more standbys than the fixtures have, and do the tiles answer the first questions of an incident?
- Live View against a busy database for ten minutes: do the figures move without flicker, does the page stay responsive?
- Live View with a kubeconfig that lacks `pods/proxy`: is the permission panel clear about what to grant?
- Open psql on Windows and Linux desktops: does the tab open and reach the prompt (the suites run on macOS locally and on Linux in CI)?
- Object Stores: do the recovery windows answer "how far back can I go" at a glance, and is an orphan server clear?
- Failover Quorums: is the sentence about R, W and N right for somebody who knows the operator, and clear for somebody who does not?
- Poolers: do the live figures next to the parameters explain each other (pool size against clients waiting)?
- Databases: does a failed database tell at once which part failed, without opening the YAML?
- Database Roles: are the attributes that override every restriction (Superuser, Bypass RLS) visible enough, and is the inline conflict sentence clear about what to do?
- Publications and Subscriptions: does the replication path read as one flow, and is the failover caveat worded for somebody who has never lost a slot?
- Logs: can you follow an incident from these rows alone (a failing query, a WAL archiving failure), and are the fields on the second line the right ones?
- Timeline: does the order of events, backups and changes of primary tell the story of the cluster, and is the block of what is to come worth its space?
- Operator: is this what a platform engineer checks first, and does the reconcile table say something at a glance?
- Cluster drawer, primary lease: is the sentence about the timings right for somebody who knows the operator, and clear for somebody who does not?
- Every view, both themes: is this the best possible view for the task?
