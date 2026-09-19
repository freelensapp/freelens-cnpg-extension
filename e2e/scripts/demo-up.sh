#!/usr/bin/env bash
# Copyright (c) Freelens Authors. All rights reserved.
# Licensed under MIT License. See LICENSE in root directory for more information.
#
# `pnpm demo:up` (SPEC-0008): the cluster a human looks at during a milestone
# review. It is the E2E cluster under a name and a state folder of its own, plus
# a small continuous pgbench load on e2e-main, so the live view moves. On a
# small machine point it at the E2E cluster instead:
#   DEMO_CLUSTER_NAME=cnpg-e2e DEMO_STATE_DIR=.e2e pnpm demo:up

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

apply_load() {
	local image
	image="$(kubectl_e2e get clusters.postgresql.cnpg.io e2e-main --namespace "${E2E_NAMESPACE}" -o 'jsonpath={.status.image}')"
	[ -n "${image}" ] || die "e2e-main reports no image, so the pgbench load has nothing to run with"

	log "applying the pgbench load with ${image}"
	# A finished init job cannot be re-applied with a different template:
	# it is replaced, the tables it created stay.
	kubectl_e2e delete job demo-pgbench-init --namespace "${E2E_NAMESPACE}" --ignore-not-found >/dev/null
	sed "s|__POSTGRES_IMAGE__|${image}|g" "${E2E_FIXTURES_DIR}/demo/70-pgbench.yaml" |
		kubectl_e2e apply -f - >/dev/null

	log "waiting for the pgbench tables (up to 300s)"
	kubectl_e2e wait --for=condition=complete job/demo-pgbench-init --namespace "${E2E_NAMESPACE}" --timeout=300s >/dev/null
	wait_rollout "${E2E_NAMESPACE}" demo-pgbench
}

main() {
	"${DEMO_SCRIPTS_DIR}/cluster-up.sh"
	apply_load
	log "demo ready: add ${E2E_KUBECONFIG} to Freelens (context ${E2E_KUBE_CONTEXT}), see docs/development/TRY-IT.md"
}

main "$@"
