/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Connect section of the Cluster and Pooler drawers (SPEC-0031): the
// services with their hosts, the application user, the copy buttons of its
// Secret, and the local port forwards main runs. The Secret is read when a copy
// button is pressed and its value goes to the clipboard only: not into state,
// logs, IPC or storage. The forwards are main's (`main/port-forwards.ts`); the
// list is asked again every few seconds while the drawer is open.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { activeClusterId, cnpgIpc } from "../ipc";
import { useAccessGuard } from "./access-review";
import { humanizeRelative } from "./backup-health";
import { psqlCommand, SECRET_KEY_WORDS, secretValue } from "./connect";
import styles from "./connect-section.module.scss";

import type { ForwardDto } from "../../common/ipc";
import type { ApplicationUser, SecretKey, ServiceRow } from "./connect";

const { observer } = MobxReact;

const {
  Component: { DrawerItem, DrawerTitle, Notifications, Table, TableCell, TableHead, TableRow, WithTooltip },
  K8sApi: { secretsApi },
} = Renderer;

/** How often the drawer asks main for the forwards of the cluster. */
const FORWARDS_REFRESH_MS = 3000;

interface SecretLike {
  data?: Record<string, string | undefined>;
}

async function copySecretKey(namespace: string, user: ApplicationUser, key: SecretKey): Promise<void> {
  let value: string | undefined;
  try {
    const secret = (await secretsApi.get({ name: user.secret, namespace })) as SecretLike | null;
    if (!secret) {
      Notifications.error(`No application user Secret ${user.secret} in ${namespace}.`);
      return;
    }
    value = secretValue(secret.data, key);
  } catch {
    Notifications.error(`The Secret ${user.secret} could not be read.`);
    return;
  }
  if (value === undefined) {
    Notifications.error(`The Secret ${user.secret} has no ${key}.`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    Notifications.error("The clipboard refused the copy.");
    return;
  }
  // Never the value: what was copied, in words.
  Notifications.ok(`Copied ${SECRET_KEY_WORDS[key]} of the user ${user.user} to the clipboard.`);
}

async function copyText(text: string, words: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    Notifications.ok(`Copied ${words} to the clipboard.`);
  } catch {
    Notifications.error("The clipboard refused the copy.");
  }
}

/** The forwards of the cluster, asked again every few seconds while mounted. */
function useForwards(namespace: string, cluster: string): [ForwardDto[], () => void] {
  const [forwards, setForwards] = React.useState<ForwardDto[]>([]);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const clusterId = activeClusterId();
    const ipc = cnpgIpc();
    if (!clusterId || !ipc) return;
    let mounted = true;
    const read = () =>
      void ipc.listForwards({ clusterId, namespace, cluster }).then(
        (list) => mounted && setForwards(Array.isArray(list) ? list : []),
        () => undefined,
      );
    read();
    const timer = setInterval(read, FORWARDS_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [namespace, cluster, tick]);
  return [forwards, () => setTick((value) => value + 1)];
}

export interface ConnectSectionProps {
  namespace: string;
  /** The CloudNativePG cluster the services belong to. */
  cluster: string;
  rows: ServiceRow[];
  /** The application user of a cluster; a pooler has none of its own. */
  user?: ApplicationUser;
}

const COPIES: Array<[SecretKey, string]> = [
  ["password", "Password"],
  ["uri", "URI"],
  ["jdbc-uri", "JDBC URI"],
  ["fqdn-uri", "URI (FQDN)"],
  ["fqdn-jdbc-uri", "JDBC URI (FQDN)"],
];

export const ConnectSection = observer(({ namespace, cluster, rows, user }: ConnectSectionProps) => {
  const secretAccess = useAccessGuard(user ? [{ verb: "get", group: "", resource: "secrets", namespace }] : []);
  const forwardAccess = useAccessGuard([
    { verb: "create", group: "", resource: "pods", subresource: "portforward", namespace },
  ]);
  const [forwards, refresh] = useForwards(namespace, cluster);
  const [starting, setStarting] = React.useState<string | undefined>(undefined);
  const services = new Set(rows.map((row) => row.service));
  const mine = forwards.filter((forward) => services.has(forward.service));
  const now = new Date();

  const forward = async (service: string) => {
    const clusterId = activeClusterId();
    const ipc = cnpgIpc();
    if (!clusterId || !ipc) {
      Notifications.error("The extension cannot reach its main process: reload Freelens.");
      return;
    }
    setStarting(service);
    try {
      const answer = await ipc.startForward({ clusterId, namespace, cluster, service });
      if (answer?.forward?.port) {
        Notifications.ok(`127.0.0.1:${answer.forward.port} now forwards to ${service}.`);
      } else {
        Notifications.error(`No local port for ${service}: ${answer?.error ?? "main did not answer"}.`);
      }
    } finally {
      setStarting(undefined);
      refresh();
    }
  };

  const stop = async (id: string) => {
    await cnpgIpc()?.stopForward(id);
    refresh();
  };

  return (
    <>
      <DrawerTitle>Connect</DrawerTitle>
      <div className={styles.table} data-testid="cnpg-connect-section">
        <Table scrollable={false} sortSyncWithUrl={false}>
          <TableHead flat sticky={false}>
            <TableCell className={styles.service}>Service</TableCell>
            <TableCell className={styles.host}>Host</TableCell>
            <TableCell className={styles.purpose}>For</TableCell>
            <TableCell className={styles.actions} />
          </TableHead>
          {rows.map((row) => (
            <TableRow key={row.service} nowrap>
              <TableCell className={styles.service}>
                <span data-testid={`cnpg-connect-row-${row.service}`}>{row.service}</span>
              </TableCell>
              <TableCell className={styles.host}>
                <WithTooltip tooltip={`${row.fqdn}:${row.port}`}>
                  <span className={styles.mono}>
                    {row.host}:{row.port}
                  </span>
                </WithTooltip>
              </TableCell>
              <TableCell className={styles.purpose}>
                <WithTooltip>{row.purpose}</WithTooltip>
              </TableCell>
              <TableCell className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  data-testid={`cnpg-connect-forward-${row.service}`}
                  disabled={!forwardAccess.enabled || starting !== undefined}
                  title={
                    forwardAccess.enabled ? `Forward a local port on 127.0.0.1 to ${row.service}` : forwardAccess.reason
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    void forward(row.service);
                  }}
                >
                  {starting === row.service ? "Forwarding" : "Forward a local port"}
                </button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </div>
      {user ? (
        <>
          <DrawerItem name="Database">{user.database}</DrawerItem>
          <DrawerItem name="User">{user.user}</DrawerItem>
          <DrawerItem name="Secret">
            <span className={styles.mono}>{user.secret}</span>{" "}
            {secretAccess.enabled ? (
              <span className={styles.buttons}>
                <span className={styles.mono}>••••••</span>
                {COPIES.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={styles.button}
                    data-testid={`cnpg-connect-copy-${key}`}
                    title={`Copy ${SECRET_KEY_WORDS[key]} from ${user.secret}: read now, kept nowhere`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void copySecretKey(namespace, user, key);
                    }}
                  >
                    Copy {label}
                  </button>
                ))}
              </span>
            ) : (
              <span className={styles.hint} data-testid="cnpg-connect-secret-denied">
                {secretAccess.reason}
              </span>
            )}
          </DrawerItem>
        </>
      ) : null}
      {mine.length > 0 ? (
        <div className={styles.table} data-testid="cnpg-connect-forwards">
          <Table scrollable={false} sortSyncWithUrl={false}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.service}>Forwarded</TableCell>
              <TableCell className={styles.host}>Local address</TableCell>
              <TableCell className={styles.purpose}>State</TableCell>
              <TableCell className={styles.actions} />
            </TableHead>
            {mine.map((item) => (
              <TableRow key={item.id} nowrap>
                <TableCell className={styles.service}>{item.service}</TableCell>
                <TableCell className={styles.host}>
                  <span
                    className={styles.mono}
                    data-testid={`cnpg-forward-${item.service}`}
                    data-port={item.port ?? ""}
                    data-state={item.state}
                  >
                    {item.port ? `127.0.0.1:${item.port}` : "N/A"}
                  </span>
                </TableCell>
                <TableCell className={styles.purpose}>
                  <WithTooltip>
                    {item.state === "ended"
                      ? `Ended: ${item.ended ?? "kubectl exited"}`
                      : `Since ${humanizeRelative(new Date(item.startedAt), now)}`}
                  </WithTooltip>
                </TableCell>
                <TableCell className={styles.actions}>
                  <span className={styles.buttons}>
                    {item.port && item.state === "running" && user ? (
                      <button
                        type="button"
                        className={styles.button}
                        data-testid={`cnpg-forward-psql-${item.service}`}
                        title="psql asks for the password, or reads it from ~/.pgpass"
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyText(psqlCommand(item.port ?? 0, user.database, user.user), "the psql command");
                        }}
                      >
                        Copy psql command
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.button}
                      data-testid={`cnpg-forward-stop-${item.service}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void stop(item.id);
                      }}
                    >
                      {item.state === "ended" ? "Dismiss" : "Stop"}
                    </button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      ) : null}
    </>
  );
});
