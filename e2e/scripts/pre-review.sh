#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm pre-review` (SPEC-0008): the agent pass that precedes a human milestone
# review. It brings the demo cluster up, walks every view on both themes with
# the pre-review suite and leaves screenshots and a report in
# e2e-artifacts/pre-review/. On a small machine point it at the E2E cluster:
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
export E2E_ARTIFACTS_DIR="${PRE_REVIEW_REPO_ROOT}/e2e-artifacts/pre-review"
export E2E_TEST_PATTERN="pre-review"

mkdir -p "${E2E_ARTIFACTS_DIR}"
exec "${PRE_REVIEW_SCRIPTS_DIR}/run-suite.sh"
