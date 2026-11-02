/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What main takes of Freelens to run kubectl for a Kubernetes cluster: the
// kubectl the host runs for it (`Main.Shell.getKubectlPath`), the environment
// the host gives for it (`Main.Shell.getEnvironment`), whose proxy carries the
// identity of the host's connection, and its connection status from the
// catalog. As freelens-kafka-extension does for its tunnels (SPEC-0031).

import { dirname } from "node:path";
import { Main } from "@freelensapp/extensions";
import { reaction } from "mobx";

import type { KubectlHost } from "./kubectl";

/** The host of the extension whose package is at `manifest`. */
export function createKubectlHost(manifest: () => string): KubectlHost {
  return {
    kubectl: (clusterId) => Main.Shell.getKubectlPath(clusterId),
    environment: (clusterId) => Main.Shell.getEnvironment(clusterId),
    watchStatus: (clusterId, listener) =>
      reaction(
        () => {
          const status = Main.Catalog.getClusterById(clusterId)?.status;
          return status === undefined ? undefined : String(status);
        },
        (status) => listener(status),
        { fireImmediately: true },
      ),
    cwd: () => dirname(manifest()),
  };
}
