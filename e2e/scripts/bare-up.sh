#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm e2e:bare:up` (SPEC-0036): a kind cluster with nothing of CloudNativePG,
# one node, for the installation guide the extension shows where the operator
# is missing. Its kubeconfig is .e2e-bare/kubeconfig; Freelens dev runs on it
# with `E2E_CLUSTER_NAME=cnpg-bare E2E_STATE_DIR=.e2e-bare pnpm e2e:freelens`,
# and `integration/__tests__/cnpg-bare.tests.ts` runs against it with the same
# variables. `pnpm e2e:bare:down` deletes it.

set -euo pipefail

BARE_SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BARE_REPO_ROOT="$(cd -- "${BARE_SCRIPTS_DIR}/../.." && pwd)"
export E2E_CLUSTER_NAME="${BARE_CLUSTER_NAME:-cnpg-bare}"
export E2E_STATE_DIR="${BARE_REPO_ROOT}/.e2e-bare"
source "${BARE_SCRIPTS_DIR}/lib.sh"

main() {
  require_docker
  require_command kind kubectl
  mkdir -p "${E2E_STATE_DIR}"
  if kind get clusters 2>/dev/null | grep -qx "${E2E_CLUSTER_NAME}"; then
    log "cluster ${E2E_CLUSTER_NAME} already exists, reusing it"
  else
    log "creating cluster ${E2E_CLUSTER_NAME} (${KIND_NODE_IMAGE}, one node, no CloudNativePG)"
    kind create cluster --name "${E2E_CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" \
      --kubeconfig "${E2E_KUBECONFIG}" --wait 5m
  fi
  kind export kubeconfig --name "${E2E_CLUSTER_NAME}" --kubeconfig "${E2E_KUBECONFIG}"
  chmod 600 "${E2E_KUBECONFIG}"
  if kubectl_e2e get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
    die "${E2E_CLUSTER_NAME} serves the CloudNativePG kinds: it is not a bare cluster"
  fi
  log "bare cluster ready: kubeconfig=${E2E_KUBECONFIG} context=${E2E_KUBE_CONTEXT}"
}

main "$@"
