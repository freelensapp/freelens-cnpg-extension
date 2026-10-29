#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm e2e:bare:down`: deletes the bare cluster of `pnpm e2e:bare:up` and its state.

set -euo pipefail

BARE_SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BARE_REPO_ROOT="$(cd -- "${BARE_SCRIPTS_DIR}/../.." && pwd)"
export E2E_CLUSTER_NAME="${BARE_CLUSTER_NAME:-cnpg-bare}"
export E2E_STATE_DIR="${BARE_REPO_ROOT}/.e2e-bare"

"${BARE_SCRIPTS_DIR}/cluster-down.sh"
rm -rf "${E2E_STATE_DIR}"
