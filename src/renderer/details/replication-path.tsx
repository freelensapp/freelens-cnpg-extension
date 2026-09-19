/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The replication path of SPEC-0015: the publisher on the left, the subscriber
// on the right and the direction between them. A Publication and a
// Subscription are one flow, and neither object alone tells it.

import { Renderer } from "@freelensapp/extensions";
import styles from "./declarative-details.module.scss";

const {
  Component: { Icon },
} = Renderer;

export interface PathEnd {
  /** The cluster, as a link when it is one of this Kubernetes cluster. */
  cluster: React.ReactNode;
  database: string;
  /** The publication or the subscription, as a link when the object is here. */
  object: React.ReactNode;
}

export interface ReplicationPathProps {
  publisher: PathEnd;
  subscriber: PathEnd;
  testId?: string;
}

function End({ title, objectLabel, end }: { title: string; objectLabel: string; end: PathEnd }) {
  return (
    <div className={styles.end}>
      <span className={styles.endTitle}>{title}</span>
      <span className={styles.endLine}>{end.cluster}</span>
      <span className={styles.endLine}>database {end.database || "N/A"}</span>
      <span className={styles.endLine}>
        {objectLabel} {end.object}
      </span>
    </div>
  );
}

export function ReplicationPath({ publisher, subscriber, testId }: ReplicationPathProps) {
  return (
    <div className={styles.path} data-testid={testId}>
      <End title="Publisher" objectLabel="publication" end={publisher} />
      <div className={styles.arrow}>
        <Icon material="arrow_forward" />
        <span>row changes</span>
      </div>
      <End title="Subscriber" objectLabel="subscription" end={subscriber} />
    </div>
  );
}
