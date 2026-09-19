/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Logs page (SPEC-0018): the JSON lines of every instance of a cluster as
// rows on one time axis: who said it, how serious it is, the message, and for
// PostgreSQL the user, the database and the query. Read through the Kubernetes
// pod log API, followed live. The host's own log viewer stays one click away
// for the raw text of one pod.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { Cluster } from "../api/cnpg/cluster-v1";
import { createPodLogsClient, logsFailureSentence } from "../api/instance/pod-logs";
import { humanizeRelative } from "../components/backup-health";
import { instanceFacts } from "../components/cluster-health";
import { ClusterPickerPage, pageParam } from "../components/cluster-picker-page";
import { withErrorPage } from "../components/error-page";
import liveStyles from "../components/live/live.module.scss";
import { MAX_LINES } from "../components/logs/log-buffer";
import { filterLines, levelCounts, sourceCounts } from "../components/logs/log-filter";
import styles from "../components/logs/logs.module.scss";
import stylesInline from "../components/logs/logs.module.scss?inline";
import { LogsPoller } from "../components/logs/logs-poller";
import { useReferenceStores } from "../components/reference-loader";
import { LIVE_CLUSTER_PARAM, LOGS_INSTANCE_PARAM, logsUrl } from "../navigation";

import type { MinimumLevel } from "../components/logs/log-filter";
import type { LogLevel, LogLine, LogSource } from "../components/logs/log-line";

const { observer } = MobxReact;

const {
  Component: { Icon, Select, SearchInput, logTabStore },
  K8sApi: { podsStore },
} = Renderer;

/** Rows kept in the DOM: the newest of what passes the filter. */
const MAX_ROWS = 1000;
const POSTGRES_CONTAINER = "postgres";

const LEVEL_OPTIONS: { value: MinimumLevel; label: string }[] = [
  { value: "all", label: "All levels" },
  { value: "warning", label: "Warnings and errors" },
  { value: "error", label: "Errors" },
];

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: styles.levelError,
  warning: styles.levelWarning,
  info: styles.levelQuiet,
  debug: styles.levelQuiet,
};

const ROW_CLASS: Record<LogLevel, string> = { error: styles.rowError, warning: styles.rowWarning, info: "", debug: "" };

function clock(time: Date | undefined): string {
  if (!time) return "";
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** The containers of an instance pod that keep running: PostgreSQL and the plugin sidecars. */
function containersOf(namespace: string, pods: readonly string[]): string[] {
  const names = new Set<string>([POSTGRES_CONTAINER]);
  for (const name of pods) {
    const pod = podsStore.getByName(name, namespace);
    for (const container of pod?.spec?.containers ?? []) names.add(container.name);
    for (const container of pod?.spec?.initContainers ?? []) {
      if ((container as { restartPolicy?: string }).restartPolicy === "Always") names.add(container.name);
    }
  }
  return [...names];
}

interface LogsPanelProps {
  cluster: Cluster;
  container: string;
  onContainer: (container: string) => void;
}

const LogRow = React.memo(({ line, showPod }: { line: LogLine; showPod: boolean }) => {
  const [open, setOpen] = React.useState(false);
  return (
    // A row of a log, not a form control: it opens on a click and on Enter or Space.
    <div
      className={[styles.row, showPod ? "" : styles.rowSingle, ROW_CLASS[line.level]].filter(Boolean).join(" ")}
      data-testid="cnpg-log-row"
      data-level={line.level}
      data-source={line.source}
      data-pod={line.pod}
      role="button"
      tabIndex={0}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") setOpen((value) => !value);
      }}
    >
      <span className={styles.time} title={line.time?.toISOString()}>
        {clock(line.time)}
      </span>
      {showPod ? (
        <span className={styles.pod} title={line.pod}>
          {line.pod}
        </span>
      ) : null}
      <span className={styles.source} title={line.logger ? `logger: ${line.logger}` : undefined}>
        {line.source}
      </span>
      <span className={LEVEL_CLASS[line.level]}>{line.level}</span>
      <span className={styles.message}>
        {line.message}
        {line.fields.length > 0 ? (
          <span className={styles.fields}>
            {line.fields.map((field, index) => (
              <span key={field.name}>
                {index > 0 ? "  " : ""}
                <span className={styles.fieldName}>{field.name}</span> {field.value}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {open ? <pre className={styles.raw}>{pretty(line.raw)}</pre> : null}
    </div>
  );
});

const LogsPanel = observer(({ cluster, container, onContainer }: LogsPanelProps) => {
  const namespace = cluster.getNs() ?? "";
  const latest = React.useRef(cluster);
  latest.current = cluster;

  const instanceParam = pageParam(LOGS_INSTANCE_PARAM);
  const instances = instanceFacts(cluster);
  const podNames = instances.map((instance) => instance.name);
  const primary = Cluster.getPrimary(cluster);
  const hibernated = Cluster.getHibernation(cluster);

  // The door of an instance arrives with its name in the URL; afterwards the chips decide.
  const requested = instanceParam.get() ?? "";
  const [pods, setPods] = React.useState<string[]>(requested ? [requested] : []);
  const [sources, setSources] = React.useState<LogSource[]>([]);
  const [minimum, setMinimum] = React.useState<MinimumLevel>("all");
  const [text, setText] = React.useState("");

  const poller = React.useMemo(
    () =>
      new LogsPoller({
        client: createPodLogsClient(),
        container,
        targets: () => {
          const current = latest.current;
          if (Cluster.getHibernation(current)) return [];
          const ns = current.getNs() ?? "";
          return instanceFacts(current).map((instance) => ({ namespace: ns, pod: instance.name }));
        },
      }),
    // One poller per cluster and container: a different one is a different panel (see the key of the page).
    [container],
  );

  React.useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const all = poller.lines;
  const scoped = filterLines(all, { pods, sources: [], minimum: "all", text: "" });
  const visible = filterLines(all, { pods, sources, minimum, text });
  const rows = visible.length > MAX_ROWS ? visible.slice(visible.length - MAX_ROWS) : visible;
  const counts = levelCounts(scoped);
  const failures = [...poller.failures.entries()];
  const forbidden = failures.find(([, failure]) => failure.kind === "forbidden");

  // The view follows the newest line unless the reader scrolled up to read something.
  const viewport = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);
  const lastId = rows.length > 0 ? rows[rows.length - 1].id : "";
  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lastId, rows.length]);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const openHostLogs = () => {
    const name = pods.length === 1 ? pods[0] : (primary ?? podNames[0]);
    const pod = name ? podsStore.getByName(name, namespace) : undefined;
    const selectedContainer =
      pod?.spec?.containers?.find((item) => item.name === container) ??
      pod?.spec?.initContainers?.find((item) => item.name === container);
    if (pod && selectedContainer) logTabStore.createPodTab({ selectedPod: pod, selectedContainer });
  };

  if (hibernated) {
    return (
      <div className={liveStyles.panel} data-testid="cnpg-logs-hibernated">
        <strong>Hibernated:</strong> there are no instances, so nothing is writing logs. Kubernetes does not keep the
        logs of pods that are gone.
      </div>
    );
  }

  return (
    <>
      <div className={styles.toolbar} data-testid="cnpg-logs-toolbar">
        <div className={styles.group}>
          <span className={styles.groupLabel}>Instances</span>
          {podNames.map((name) => (
            <button
              key={name}
              type="button"
              className={[styles.chip, pods.length === 0 || pods.includes(name) ? styles.chipOn : ""].join(" ").trim()}
              data-testid={`cnpg-logs-instance-${name}`}
              aria-pressed={pods.includes(name)}
              title={name === primary ? "The primary" : "A standby"}
              onClick={() => {
                instanceParam.set("");
                setPods((current) => toggle(current, name));
              }}
            >
              {name === primary ? <Icon small material="star" /> : null}
              {name}
            </button>
          ))}
        </div>
        <div className={styles.select}>
          <Select
            id="cnpg-logs-container"
            options={containersOf(namespace, podNames).map((name) => ({ value: name, label: `container ${name}` }))}
            value={container}
            onChange={(option) => onContainer(option?.value ?? POSTGRES_CONTAINER)}
            themeName="lens"
          />
        </div>
        <div className={styles.select}>
          <Select
            id="cnpg-logs-level"
            options={LEVEL_OPTIONS.map((option) => ({
              value: option.value,
              label:
                option.value === "error"
                  ? `${option.label} (${counts.error})`
                  : option.value === "warning"
                    ? `${option.label} (${counts.error + counts.warning})`
                    : option.label,
            }))}
            value={minimum}
            onChange={(option) => setMinimum((option?.value as MinimumLevel | undefined) ?? "all")}
            themeName="lens"
          />
        </div>
        <div className={styles.search}>
          <SearchInput
            value={text}
            placeholder="Filter the lines"
            onChange={(value: string) => setText(value)}
            data-testid="cnpg-logs-text"
          />
        </div>
        <span className={[liveStyles.controls, styles.spacer].join(" ")}>
          <button
            type="button"
            className={liveStyles.control}
            aria-label={poller.following ? "Stop following" : "Follow the logs"}
            title={poller.following ? "Stop following" : "Follow the logs"}
            data-testid="cnpg-logs-follow"
            onClick={() => poller.setFollowing(!poller.following)}
          >
            <Icon small material={poller.following ? "pause" : "play_arrow"} />
          </button>
          <button
            type="button"
            className={liveStyles.control}
            aria-label="Read now"
            title="Read now"
            onClick={() => void poller.refresh()}
          >
            <Icon small material="refresh" />
          </button>
          <button
            type="button"
            className={liveStyles.control}
            aria-label="Clear the view"
            title="Clear the view: only what is written from now on"
            onClick={() => poller.clear()}
          >
            <Icon small material="clear_all" />
          </button>
          <button
            type="button"
            className={liveStyles.control}
            aria-label="Open the raw logs in the log viewer of Freelens"
            title="Open the raw logs of the selected instance (or of the primary) in the log viewer of Freelens"
            data-testid="cnpg-logs-host-viewer"
            onClick={openHostLogs}
          >
            <Icon small material="subject" />
          </button>
        </span>
      </div>

      <div className={styles.group} data-testid="cnpg-logs-sources">
        <span className={styles.groupLabel}>Who said it</span>
        {sourceCounts(scoped).map(({ source, count }) => (
          <button
            key={source}
            type="button"
            className={[styles.chip, sources.length === 0 || sources.includes(source) ? styles.chipOn : ""]
              .join(" ")
              .trim()}
            data-testid={`cnpg-logs-source-${source.replace(/\s+/g, "-").toLowerCase()}`}
            aria-pressed={sources.includes(source)}
            onClick={() => setSources((current) => toggle(current, source))}
          >
            {source} <span className={styles.chipCount}>{count}</span>
          </button>
        ))}
      </div>

      {forbidden ? (
        <div className={liveStyles.panel} data-testid="cnpg-logs-forbidden">
          <strong>The logs cannot be read.</strong>{" "}
          {logsFailureSentence(forbidden[1], { namespace, pod: forbidden[0] })}. The lists and the drawers of the
          extension keep working without it.
        </div>
      ) : (
        <>
          <div
            className={styles.viewport}
            ref={viewport}
            data-testid="cnpg-logs-viewport"
            onScroll={(event) => {
              const element = event.currentTarget;
              stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            }}
          >
            {rows.map((line) => (
              <LogRow key={line.id} line={line} showPod={podNames.length > 1} />
            ))}
            {poller.answered && rows.length === 0 ? (
              <div className={styles.row}>
                <span className={styles.message} style={{ gridColumn: "1 / -1" }}>
                  {all.length === 0 ? "No line yet from the instances of this cluster" : "No line passes the filters"}
                </span>
              </div>
            ) : null}
          </div>
          <div className={styles.status} data-testid="cnpg-logs-status">
            <span>
              {poller.answered
                ? `${visible.length} of ${all.length} lines${visible.length > MAX_ROWS ? `, the last ${MAX_ROWS} shown` : ""}`
                : `Reading the last lines of ${podNames.length} instance${podNames.length === 1 ? "" : "s"}`}
            </span>
            <span>
              {poller.following ? `following every ${poller.intervalMs / 1000} s` : "not following"}
              {poller.lastRead ? `, last read ${humanizeRelative(new Date(poller.lastRead), new Date())}` : ""}
            </span>
            <span>the view keeps the last {MAX_LINES} lines; Kubernetes keeps what the node has not rotated yet</span>
            {failures.map(([pod, failure]) => (
              <span key={pod} className={styles.failure}>
                {logsFailureSentence(failure, { namespace, pod })}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
});

export interface LogsPageProps {
  extension: Renderer.LensExtension;
}

export const LogsPage = observer((props: LogsPageProps) =>
  withErrorPage(props, () => {
    const { extension } = props;
    const [container, setContainer] = React.useState(POSTGRES_CONTAINER);

    // The pods say which containers an instance has and let the host viewer open.
    useReferenceStores([
      { label: Cluster.crd.plural, store: Cluster.getStore<Cluster>() },
      { label: "pods", store: podsStore },
    ]);

    return (
      <ClusterPickerPage
        extension={extension}
        title="Logs"
        testId="cnpg-logs"
        paramName={LIVE_CLUSTER_PARAM}
        urlOf={(namespace, name) => logsUrl(extension.name, namespace, name)}
        extraStyles={stylesInline}
      >
        {(cluster, key) => (
          // The key gives every cluster and container a panel, a poller and a buffer of its own.
          <LogsPanel key={`${key}/${container}`} cluster={cluster} container={container} onContainer={setContainer} />
        )}
      </ClusterPickerPage>
    );
  }),
);
