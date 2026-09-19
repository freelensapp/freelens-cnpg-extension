/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The reading loop of the Logs page (SPEC-0018): the last lines of every
// instance first, then what each of them wrote since the last line seen,
// every few seconds while the page follows and the window is visible. One
// request per pod at a time; a pod that fails does not hide the others.

import { action, makeObservable, observable, runInAction } from "mobx";
import { documentVisibility } from "../live/live-poller";
import { lastStamp, mergeLines } from "./log-buffer";
import { parseLogText } from "./log-line";

import type { PodLogsClient } from "../../api/instance/pod-logs";
import type { ProxyFailure } from "../../api/instance/pod-proxy";
import type { Visibility } from "../live/live-poller";
import type { LogLine } from "./log-line";

export const LOGS_INTERVAL_MS = 3000;

export interface LogsTarget {
  namespace: string;
  pod: string;
}

export interface LogsPollerOptions {
  client: PodLogsClient;
  /** Read at every round, so the loop follows the pods as they come and go. */
  targets: () => LogsTarget[];
  container: string;
  intervalMs?: number;
  visibility?: Visibility;
  now?: () => number;
}

export class LogsPoller {
  lines: LogLine[] = [];
  readonly failures = observable.map<string, ProxyFailure>({}, { deep: false });
  following = true;
  /** True once a round has come back, whatever it brought. */
  answered = false;
  lastRead: number | undefined = undefined;

  readonly intervalMs: number;
  readonly container: string;

  private readonly client: PodLogsClient;
  private readonly targets: () => LogsTarget[];
  private readonly visibility: Visibility;
  private readonly now: () => number;
  /** Per pod, the stamp of the last line read: what the next read starts from, also after a clear. */
  private readonly since = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private busy = false;

  constructor(options: LogsPollerOptions) {
    this.client = options.client;
    this.targets = options.targets;
    this.container = options.container;
    this.intervalMs = options.intervalMs ?? LOGS_INTERVAL_MS;
    this.visibility = options.visibility ?? documentVisibility;
    this.now = options.now ?? Date.now;
    makeObservable(this, {
      lines: observable.ref,
      following: observable,
      answered: observable,
      lastRead: observable,
      setFollowing: action,
      clear: action,
    });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.visibility.subscribe(() => this.reschedule());
    this.reschedule();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
  }

  setFollowing(following: boolean): void {
    this.following = following;
    this.reschedule();
  }

  /** Empties the view; the next reads bring only what is written from now on. */
  clear(): void {
    this.lines = [];
  }

  /** One round now, whatever the follow toggle says. */
  async refresh(): Promise<void> {
    await this.round();
  }

  private get active(): boolean {
    return Boolean(this.unsubscribe) && this.following && !this.visibility.isHidden();
  }

  private reschedule(): void {
    clearTimeout(this.timer);
    if (!this.unsubscribe) return;
    // The first read happens even when not following: an empty page tells nothing.
    if (!this.active && this.answered) return;
    const tick = async () => {
      await this.round();
      if (this.active) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  private async round(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const targets = this.targets();
      const results = await Promise.all(
        targets.map(async (target) => {
          // A pod never read, or one that has written nothing yet, is asked for its tail.
          const sinceTime = this.since.get(target.pod);
          const result = await this.client.getLogs({
            namespace: target.namespace,
            pod: target.pod,
            container: this.container,
            ...(sinceTime ? { sinceTime } : {}),
          });
          return { target, result };
        }),
      );
      // The page went away while the requests were out: nobody wants the answers.
      if (!this.unsubscribe) return;

      runInAction(() => {
        const pods = new Set(targets.map((target) => target.pod));
        for (const pod of [...this.failures.keys()]) if (!pods.has(pod)) this.failures.delete(pod);
        let lines = this.lines;
        for (const { target, result } of results) {
          if (result.ok) {
            this.failures.delete(target.pod);
            const parsed = parseLogText(result.value, target.pod);
            const stamp = lastStamp(parsed, target.pod);
            if (stamp) this.since.set(target.pod, stamp);
            lines = mergeLines(lines, parsed);
            this.lastRead = this.now();
          } else {
            this.failures.set(target.pod, result.failure);
          }
        }
        this.lines = lines;
        this.answered = true;
      });
    } finally {
      this.busy = false;
    }
  }
}
