#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm pre-review` (SPEC-0008): the agent pass that precedes a human milestone
# review. It brings the demo cluster up, walks every view on both themes with
# the pre-review suite and leaves screenshots and a report in
# e2e-artifacts/pre-review/. Freelens dev must be running on the demo's
# kubeconfig, as e2e/scripts/freelens-dev.sh starts it:
#   E2E_CLUSTER_NAME=cnpg-demo E2E_STATE_DIR=.demo pnpm e2e:freelens
# On a small machine point both at the E2E cluster:
#   DEMO_CLUSTER_NAME=cnpg-e2e DEMO_STATE_DIR=.e2e pnpm pre-review

set -euo pipefail

PRE_REVIEW_SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${PRE_REVIEW_SCRIPTS_DIR}/demo-up.sh"

PRE_REVIEW_REPO_ROOT="$(cd -- "${PRE_REVIEW_SCRIPTS_DIR}/../.." && pwd)"
export E2E_CLUSTER_NAME="${DEMO_CLUSTER_NAME:-cnpg-demo}"
case "${DEMO_STATE_DIR:-.demo}" in
  /*) export E2E_STATE_DIR="${DEMO_STATE_DIR}" ;;
  *) export E2E_STATE_DIR="${PRE_REVIEW_REPO_ROOT}/${DEMO_STATE_DIR:-.demo}" ;;
esac
source "${PRE_REVIEW_SCRIPTS_DIR}/lib.sh"
export E2E_KUBECONFIG
export E2E_ARTIFACTS_DIR="${PRE_REVIEW_REPO_ROOT}/e2e-artifacts/pre-review"
export CNPG_PRE_REVIEW=1
mkdir -p "${E2E_ARTIFACTS_DIR}"

cdp="${FREELENS_CDP_URL:-http://127.0.0.1:9223}"
curl -sf "${cdp}/json/version" >/dev/null ||
  die "Freelens dev does not answer on ${cdp}: start it with E2E_CLUSTER_NAME=${E2E_CLUSTER_NAME} E2E_STATE_DIR=${E2E_STATE_DIR} pnpm e2e:freelens"

cd "${PRE_REVIEW_REPO_ROOT}"
# Outside CI a session that cannot reach the app or the cluster skips: the pass must not.
CI=1 exec pnpm test:integration integration/__tests__/pre-review.tests.ts --reporter=verbose
