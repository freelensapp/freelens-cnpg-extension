# shellcheck shell=bash
#
# Shared settings and helpers for the CloudNativePG E2E scripts.
#
# Sourced by cluster-up.sh, cluster-down.sh, run-suite.sh and e2e.sh. This file
# is not executable on its own.
#
# SC2034 is disabled for the whole file: everything defined here is read by the
# scripts that source it, which ShellCheck cannot see from this file alone.
# shellcheck disable=SC2034

# The single place where every component of the disposable cluster is pinned.
# The operator, cert-manager and the Barman Cloud plugin are applied from their
# release manifests at these versions; nothing is vendored into this repository
# (see docs/development/ARCHITECTURE.md and SPEC-0002).
CNPG_VERSION="${CNPG_VERSION:-1.30.0}"                          # datasource=github-releases depName=cloudnative-pg/cloudnative-pg
BARMAN_PLUGIN_VERSION="${BARMAN_PLUGIN_VERSION:-v0.15.0}"       # datasource=github-releases depName=cloudnative-pg/plugin-barman-cloud
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"         # datasource=github-releases depName=cert-manager/cert-manager
MINIO_IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z}" # datasource=docker depName=quay.io/minio/minio
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z}"          # datasource=docker depName=quay.io/minio/mc

# Pins of the disposable cluster, aligned with .github/workflows/e2e-tests.yaml.
# CloudNativePG 1.30.x supports Kubernetes 1.34, 1.35 and 1.36.
KIND_VERSION="${KIND_VERSION:-0.33.0}"             # datasource=github-releases depName=kubernetes-sigs/kind
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.36.4}" # datasource=docker depName=kindest/node
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v${KUBERNETES_VERSION}}"

CNPG_MANIFEST_URL="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v${CNPG_VERSION}/releases/cnpg-${CNPG_VERSION}.yaml"
BARMAN_PLUGIN_MANIFEST_URL="https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${BARMAN_PLUGIN_VERSION}/manifest.yaml"
CERT_MANAGER_MANIFEST_URL="https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"

E2E_SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd -- "${E2E_SCRIPTS_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${E2E_DIR}/.." && pwd)"
E2E_FIXTURES_DIR="${E2E_DIR}/fixtures"

# Name of the disposable cluster. Deliberately not "kind", so that it never
# collides with the cluster the Freelens integration tests use.
E2E_CLUSTER_NAME="${E2E_CLUSTER_NAME:-cnpg-e2e}"
E2E_KUBE_CONTEXT="kind-${E2E_CLUSTER_NAME}"

# Dedicated kubeconfig. The developer's default kubeconfig (~/.kube/config) is
# never read and never written by these scripts: kind writes only here, and the
# test suite copies this file into the sandboxed Freelens user-data directory.
E2E_STATE_DIR="${E2E_STATE_DIR:-${REPO_ROOT}/.e2e}"
E2E_KUBECONFIG="${E2E_KUBECONFIG:-${E2E_STATE_DIR}/kubeconfig}"

# Screenshots taken when an assertion fails. Kept in the repository root rather
# than in the Freelens checkout, so that CI can upload the directory.
E2E_ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-${REPO_ROOT}/e2e-artifacts}"

# Namespaces. The fixture manifests declare cnpg-e2e explicitly so that they
# stay valid when applied by hand; the operator and the plugin live where their
# manifests put them.
E2E_NAMESPACE="cnpg-e2e"
OPERATOR_NAMESPACE="cnpg-system"
CERT_MANAGER_NAMESPACE="cert-manager"

# The fixture clusters, in the order cluster-up.sh waits for them, and the
# states the readback assertions expect. Every view spec adds the objects it
# needs to the fixtures and their expected state here.
E2E_CLUSTERS=(e2e-main e2e-single e2e-hibernated e2e-fenced)
E2E_HEALTHY_PHASE="Cluster in healthy state"

# Timeouts. The first bring-up pulls the PostgreSQL, PgBouncer, MinIO,
# cert-manager, operator and plugin images, so the cluster waits are generous.
WAIT_ROLLOUT="${WAIT_ROLLOUT:-300s}"
WAIT_CLUSTER="${WAIT_CLUSTER:-900s}"
WAIT_BACKUP="${WAIT_BACKUP:-600s}"

log() {
	printf '[e2e] %s\n' "$*" >&2
}

die() {
	printf '[e2e] error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	local command
	for command in "$@"; do
		command -v "${command}" >/dev/null 2>&1 || die "missing required command: ${command}"
	done
}

require_docker() {
	require_command docker
	docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable; start Docker and retry"
}

# kubectl against the disposable cluster only. Every kubectl call of the
# scripts goes through here, so that nothing can touch another context.
kubectl_e2e() {
	kubectl --kubeconfig "${E2E_KUBECONFIG}" --context "${E2E_KUBE_CONTEXT}" "$@"
}

# Waits until `kubectl get <resource> <name> -o jsonpath=<path>` prints the
# expected value, polling every 5 seconds up to the given timeout (in seconds).
wait_for_jsonpath() {
	local namespace="$1" resource="$2" name="$3" json_path="$4" expected="$5" timeout="$6"
	local deadline actual
	deadline=$(($(date +%s) + timeout))
	while :; do
		actual="$(kubectl_e2e get "${resource}" "${name}" --namespace "${namespace}" \
			--output "jsonpath=${json_path}" 2>/dev/null || true)"
		[ "${actual}" = "${expected}" ] && return 0
		[ "$(date +%s)" -ge "${deadline}" ] &&
			die "timeout waiting for ${resource}/${name} ${json_path} to be '${expected}' (last: '${actual}')"
		sleep 5
	done
}

wait_rollout() {
	local namespace="$1"
	shift
	local deployment
	for deployment in "$@"; do
		kubectl_e2e rollout status "deployment/${deployment}" --namespace "${namespace}" \
			--timeout "${WAIT_ROLLOUT}" >/dev/null ||
			die "deployment ${namespace}/${deployment} did not become available"
	done
}
