#!/usr/bin/env bash
#
# Packs the extension, copies the E2E suite and its helpers into the Freelens
# checkout and runs it through the Freelens integration harness against the
# cluster created by cluster-up.sh. See docs/development/TESTING.md.

set -euo pipefail

# shellcheck source=e2e/scripts/lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FREELENS_DIR="${FREELENS_DIR:-${REPO_ROOT}/freelens}"
FREELENS_APP_DIR="${FREELENS_DIR}/freelens"
E2E_TEST_PATTERN="${E2E_TEST_PATTERN:-cnpg-e2e}"

require_freelens_checkout() {
	[[ -d "${FREELENS_APP_DIR}/integration/__tests__" ]] ||
		die "no Freelens checkout at ${FREELENS_DIR}. See docs/development/TESTING.md."
	compgen -G "${FREELENS_APP_DIR}/dist/*unpacked" >/dev/null ||
		compgen -G "${FREELENS_APP_DIR}/dist/mac*" >/dev/null ||
		die "Freelens is not built in ${FREELENS_APP_DIR}/dist. See docs/development/TESTING.md."
}

require_cluster() {
	[[ -f ${E2E_KUBECONFIG} ]] ||
		die "no kubeconfig at ${E2E_KUBECONFIG}. Run \`pnpm e2e:cluster:up\` first."
	kubectl_e2e get crd clusters.postgresql.cnpg.io >/dev/null 2>&1 ||
		die "the CloudNativePG CRDs are missing from ${E2E_CLUSTER_NAME}. Run \`pnpm e2e:cluster:up\` first."
}

pack_extension() {
	if [[ -n ${EXTENSION_PATH-} ]]; then
		log "using the extension tarball from EXTENSION_PATH: ${EXTENSION_PATH}"
		return
	fi
	log "building and packing the extension"
	(cd "${REPO_ROOT}" && pnpm build && pnpm clean:tgz && pnpm pack >/dev/null)
	EXTENSION_PATH="$(find "${REPO_ROOT}" -maxdepth 1 -name '*.tgz' | head -n 1)"
	[[ -n ${EXTENSION_PATH} ]] || die "pnpm pack produced no tarball"
	export EXTENSION_PATH
}

copy_suite() {
	log "copying the E2E suite into ${FREELENS_APP_DIR}/integration"
	mkdir -p "${FREELENS_APP_DIR}/integration/helpers"
	cp "${E2E_DIR}"/__tests__/*.tests.ts "${FREELENS_APP_DIR}/integration/__tests__/"
	cp "${REPO_ROOT}"/integration/helpers/*.ts "${FREELENS_APP_DIR}/integration/helpers/"
}

run_suite() {
	local -a runner=()
	if [[ "$(uname -s)" == "Linux" ]] && [[ -z ${DISPLAY-} ]] && command -v xvfb-run >/dev/null 2>&1; then
		runner=(xvfb-run -a)
	fi
	log "running the E2E suite (pattern: ${E2E_TEST_PATTERN})"
	(
		cd "${FREELENS_APP_DIR}"
		E2E_KUBECONFIG="${E2E_KUBECONFIG}" \
			E2E_CLUSTER_NAME="${E2E_CLUSTER_NAME}" \
			E2E_KUBE_CONTEXT="${E2E_KUBE_CONTEXT}" \
			E2E_NAMESPACE="${E2E_NAMESPACE}" \
			E2E_ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR}" \
			EXTENSION_PATH="${EXTENSION_PATH}" \
			${runner[@]+"${runner[@]}"} pnpm test:integration "${E2E_TEST_PATTERN}"
	)
}

main() {
	require_command kubectl pnpm
	require_freelens_checkout
	require_cluster
	pack_extension
	copy_suite
	run_suite
}

main "$@"
