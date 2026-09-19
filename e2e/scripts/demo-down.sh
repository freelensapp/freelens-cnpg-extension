#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm demo:down` (SPEC-0008): deletes the demo cluster and its state folder.
# It refuses to touch the E2E cluster: when the demo was pointed at it, only
# the pgbench load is removed.

set -euo pipefail

DEMO_SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEMO_REPO_ROOT="$(cd -- "${DEMO_SCRIPTS_DIR}/../.." && pwd)"

export E2E_CLUSTER_NAME="${DEMO_CLUSTER_NAME:-cnpg-demo}"
case "${DEMO_STATE_DIR:-.demo}" in
/*) export E2E_STATE_DIR="${DEMO_STATE_DIR}" ;;
*) export E2E_STATE_DIR="${DEMO_REPO_ROOT}/${DEMO_STATE_DIR:-.demo}" ;;
esac

# shellcheck source=e2e/scripts/lib.sh
source "${DEMO_SCRIPTS_DIR}/lib.sh"

main() {
	if [[ ${E2E_CLUSTER_NAME} == "cnpg-e2e" ]]; then
		log "the demo was pointed at the E2E cluster: removing the pgbench load only"
		kubectl_e2e delete -f "${E2E_FIXTURES_DIR}/demo/70-pgbench.yaml" --ignore-not-found >/dev/null 2>&1 || true
		return
	fi
	"${DEMO_SCRIPTS_DIR}/cluster-down.sh"
	rm -rf "${E2E_STATE_DIR}"
}

main "$@"
