/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The installation guide of SPEC-0036: what CloudNativePG needs on this
// cluster, what is there, and what to run for what is missing. The commands
// are shown to copy, never run; the documentation opens in the browser.

import { Renderer } from "@freelensapp/extensions";
import React from "react";
import { probeComponents } from "../api/operator/components";
import { guideComplete, guideSteps } from "./install-guide";
import styles from "./install-guide.module.scss";

import type { ClusterComponents, GuideStep, StepState } from "./install-guide";

const {
  Component: { Badge, Icon },
  Navigation: { navigate },
} = Renderer;

const STATE_CLASS: Record<StepState, string> = {
  installed: "success",
  missing: "error",
  "not needed": "info",
  unknown: "warning",
};

/** Asks the cluster once what it runs; undefined while the answers come. */
export function useClusterComponents(): ClusterComponents | undefined {
  const [components, setComponents] = React.useState<ClusterComponents | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    void probeComponents().then((result) => {
      if (alive) setComponents(result);
    });
    return () => {
      alive = false;
    };
  }, []);
  return components;
}

function CopyButton({ text, testId }: { text: string; testId: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  const settle = (next: "copied" | "failed") => {
    setState(next);
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button
      type="button"
      className={styles.button}
      data-testid={testId}
      title={state === "failed" ? "The clipboard refused the text: select it and copy it by hand" : undefined}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => settle("copied"),
          () => settle("failed"),
        );
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy"}
    </button>
  );
}

function Step({ step }: { step: GuideStep }) {
  return (
    <li className={styles.step} data-testid={`cnpg-install-step-${step.id}`} data-state={step.state}>
      <div className={styles.stepHead}>
        <strong>{step.title}</strong>
        <Badge className={STATE_CLASS[step.state]} label={step.state} />
      </div>
      <p className={styles.words}>{step.words}</p>
      {step.older ? <p className={styles.warning}>{step.older}</p> : null}
      {step.state === "missing" || step.state === "unknown" ? (
        <>
          {step.after ? <p className={styles.words}>{step.after}</p> : null}
          {step.commands.map((command, index) => (
            <div key={command.label} className={styles.command}>
              <span className={styles.commandLabel}>{command.label}</span>
              <pre className={styles.code} data-testid={`cnpg-install-command-${step.id}-${index}`}>
                {command.text}
              </pre>
              <CopyButton text={command.text} testId={`cnpg-install-copy-${step.id}-${index}`} />
            </div>
          ))}
        </>
      ) : null}
      <div className={styles.links}>
        <a
          href={step.docs}
          data-testid={`cnpg-install-docs-${step.id}`}
          onClick={(event) => {
            // The host opens window.open targets in the browser.
            event.preventDefault();
            window.open(step.docs, "_blank", "noopener");
          }}
        >
          Documentation <Icon small material="open_in_new" />
        </a>
        {step.chart && step.state !== "installed" ? (
          <a
            href="#helm-charts"
            data-testid={`cnpg-install-helm-${step.id}`}
            title={`Add the repository ${step.chart.url} as "${step.chart.repository}" in the Helm Charts preferences of Freelens first`}
            onClick={(event) => {
              event.preventDefault();
              navigate("/helm/charts");
            }}
          >
            Helm Charts of Freelens
          </a>
        ) : null}
      </div>
    </li>
  );
}

export interface InstallGuideProps {
  components: ClusterComponents | undefined;
  /** Shows every step even when all is installed (the Operator page shows one line then). */
  full?: boolean;
}

export function InstallGuide({ components, full = false }: InstallGuideProps) {
  if (!components) {
    return (
      <div className={styles.guide} data-testid="cnpg-install-guide" data-complete="pending">
        <span className={styles.words}>Looking at what this cluster runs</span>
      </div>
    );
  }
  const steps = guideSteps(components);
  const complete = guideComplete(steps);
  if (complete && !full) {
    return (
      <div className={styles.guide} data-testid="cnpg-install-guide" data-complete="true">
        <span className={styles.words} data-testid="cnpg-install-summary">
          {steps.map((step) => `${step.title}: ${step.state}`).join(" · ")}
        </span>
        {steps.some((step) => step.older) ? (
          <p className={styles.warning}>{steps.find((step) => step.older)?.older}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.guide} data-testid="cnpg-install-guide" data-complete={complete ? "true" : "false"}>
      <p className={styles.words}>
        What CloudNativePG needs on this cluster. The commands are for you to run, with your own access: the extension
        runs none.
      </p>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <Step key={step.id} step={step} />
        ))}
      </ol>
    </div>
  );
}
