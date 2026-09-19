/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The "Right now" block of the drawers that read a figure from the exporter of
// the current primary of a cluster (SPEC-0013, SPEC-0015): it owns the polling
// loop for as long as it is mounted and hands the samples to its children. It
// never blocks the drawer: while reading, and when the read fails, it is one
// row with one sentence.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { Cluster } from "../api/cnpg/cluster-v1";
import { createPodProxyClient, failureSentence, METRICS_PORT } from "../api/instance/pod-proxy";
import { humanizeRelative } from "./backup-health";
import { PrimaryMetricsPoller } from "./live/primary-metrics-poller";

import type { MetricSample } from "../api/instance/prometheus-text";

const { observer } = MobxReact;

const {
  Component: { DrawerItem },
} = Renderer;

export interface RightNowProps {
  /** The cluster whose primary is asked; undefined when it is not there. */
  cluster: Cluster | undefined;
  /** What to say when there is nobody to ask. */
  nobody: string;
  testId: string;
  children: (samples: readonly MetricSample[]) => React.ReactNode;
}

export const RightNow = observer(({ cluster, nobody, testId, children }: RightNowProps) => {
  const latest = React.useRef(cluster);
  latest.current = cluster;

  const poller = React.useMemo(
    () => new PrimaryMetricsPoller({ client: createPodProxyClient(), cluster: () => latest.current }),
    [],
  );

  React.useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const pod = cluster ? Cluster.getPrimary(cluster) : undefined;
  const namespace = cluster?.metadata?.namespace ?? "";

  if (!cluster || !pod) return <DrawerItem name="Right now">{nobody}</DrawerItem>;
  if (!poller.answered) {
    return <DrawerItem name="Right now">Reading the metrics exporter of the primary, {pod}</DrawerItem>;
  }

  const samples = poller.samples.get(pod);
  const failure = poller.failures.get(pod);
  if (!samples) {
    return (
      <DrawerItem name="Right now">
        {failure
          ? failureSentence(failure, { namespace, pod, port: METRICS_PORT })
          : `The primary, ${pod}, gave no answer yet`}
      </DrawerItem>
    );
  }

  return (
    <>
      <DrawerItem name="Read">
        <span data-testid={testId}>
          every {poller.intervalMs / 1000} s from the primary, {pod}
          {poller.lastSuccess ? `, last ${humanizeRelative(new Date(poller.lastSuccess), new Date())}` : ""}
        </span>
      </DrawerItem>
      {children(samples)}
    </>
  );
});
