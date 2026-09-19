#!/usr/bin/env bash
#
# Creates the disposable kind cluster the E2E suite runs against: cert-manager,
# the CloudNativePG operator, the Barman Cloud plugin, an in-cluster MinIO, then
# the fixture clusters, backups, schedule and pooler, waiting for every one of
# them to reach the state the views expect (SPEC-0002).
#
# Idempotent: running it against an existing cluster re-applies everything and
# re-checks every wait.

set -euo pipefail

# shellcheck source=e2e/scripts/lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

create_cluster() {
	if kind get clusters 2>/dev/null | grep -qx "${E2E_CLUSTER_NAME}"; then
		log "cluster ${E2E_CLUSTER_NAME} already exists, reusing it"
	else
		log "creating cluster ${E2E_CLUSTER_NAME} (${KIND_NODE_IMAGE}, 1 control plane + 2 workers)"
		kind create cluster \
			--name "${E2E_CLUSTER_NAME}" \
			--image "${KIND_NODE_IMAGE}" \
			--config "${E2E_SCRIPTS_DIR}/kind-config.yaml" \
			--kubeconfig "${E2E_KUBECONFIG}" \
			--wait 5m
	fi

	# Also covers the reuse path, where the kubeconfig file may have been removed.
	kind export kubeconfig --name "${E2E_CLUSTER_NAME}" --kubeconfig "${E2E_KUBECONFIG}"
	chmod 600 "${E2E_KUBECONFIG}"
}

apply_manifest_url() {
	local what="$1" url="$2" file
	file="$(mktemp)"
	# shellcheck disable=SC2064 # the file name is expanded now on purpose
	trap "rm -f '${file}'" RETURN
	log "applying ${what} from ${url}"
	curl --fail --silent --show-error --location --retry 3 --output "${file}" "${url}"
	# Server-side apply: the CRDs of the operator are far too large for the
	# client-side last-applied annotation.
	kubectl_e2e apply --server-side --force-conflicts -f "${file}" >/dev/null
}

install_cert_manager() {
	apply_manifest_url "cert-manager ${CERT_MANAGER_VERSION}" "${CERT_MANAGER_MANIFEST_URL}"
	wait_rollout "${CERT_MANAGER_NAMESPACE}" cert-manager cert-manager-cainjector cert-manager-webhook
	# The webhook deployment being available does not mean the API server can
	# already reach it: probe it with a server-side dry run until it answers.
	# The probe targets the `default` namespace, which always exists; the
	# fixture namespace is created later.
	local deadline
	deadline=$(($(date +%s) + 180))
	until printf 'apiVersion: cert-manager.io/v1\nkind: Issuer\nmetadata:\n  name: e2e-probe\n  namespace: default\nspec:\n  selfSigned: {}\n' |
		kubectl_e2e apply --dry-run=server -f - >/dev/null 2>&1; do
		[[ "$(date +%s)" -ge ${deadline} ]] && die "the cert-manager webhook never answered"
		sleep 5
	done
	log "cert-manager ready"
}

install_operator() {
	apply_manifest_url "CloudNativePG ${CNPG_VERSION}" "${CNPG_MANIFEST_URL}"
	wait_rollout "${OPERATOR_NAMESPACE}" cnpg-controller-manager
	kubectl_e2e wait --for=condition=Established --timeout=120s crd/clusters.postgresql.cnpg.io >/dev/null
	log "operator ready"
}

install_barman_plugin() {
	apply_manifest_url "Barman Cloud plugin ${BARMAN_PLUGIN_VERSION}" "${BARMAN_PLUGIN_MANIFEST_URL}"
	wait_rollout "${OPERATOR_NAMESPACE}" barman-cloud
	kubectl_e2e wait --for=condition=Established --timeout=120s crd/objectstores.barmancloud.cnpg.io >/dev/null
	log "Barman Cloud plugin ready"
}

apply_fixtures() {
	# Phase 1: everything the clusters depend on, then the clusters. The image
	# pins of lib.sh are substituted into the MinIO manifest so that the single
	# place where versions live stays lib.sh.
	local substituted_dir file
	substituted_dir="$(mktemp -d)"
	# shellcheck disable=SC2064 # the directory is expanded now on purpose
	trap "rm -rf '${substituted_dir}'" RETURN
	for file in "${E2E_FIXTURES_DIR}"/[0-3]*.yaml; do
		sed -e "s|__MINIO_IMAGE__|${MINIO_IMAGE}|g" -e "s|__MC_IMAGE__|${MC_IMAGE}|g" \
			"${file}" >"${substituted_dir}/$(basename "${file}")"
	done
	log "applying the namespace, MinIO, object stores and clusters"
	kubectl_e2e apply -f "${substituted_dir}" >/dev/null

	log "waiting for MinIO and its bucket"
	wait_rollout "${E2E_NAMESPACE}" minio
	kubectl_e2e wait --for=condition=complete --timeout=300s job/minio-bucket --namespace "${E2E_NAMESPACE}" >/dev/null ||
		die "the minio-bucket job did not complete; is ${MC_IMAGE} reachable?"
}

wait_clusters() {
	local name
	for name in "${E2E_CLUSTERS[@]}"; do
		log "waiting for cluster ${name} to be healthy (up to ${WAIT_CLUSTER})"
		wait_for_jsonpath "${E2E_NAMESPACE}" clusters.postgresql.cnpg.io "${name}" '{.status.phase}' \
			"${E2E_HEALTHY_PHASE}" "${WAIT_CLUSTER%s}"
	done
	wait_for_jsonpath "${E2E_NAMESPACE}" clusters.postgresql.cnpg.io e2e-main '{.status.readyInstances}' 3 "${WAIT_CLUSTER%s}"
	log "all clusters healthy"
}

apply_second_phase() {
	# Backups, the schedule and the pooler need healthy clusters to exist.
	log "applying the backups, the scheduled backups and the pooler"
	kubectl_e2e apply -f "${E2E_FIXTURES_DIR}"/40-backups.yaml \
		-f "${E2E_FIXTURES_DIR}"/50-scheduledbackups.yaml \
		-f "${E2E_FIXTURES_DIR}"/60-poolers.yaml >/dev/null

	log "waiting for backup e2e-backup-ok to complete and e2e-backup-failed to fail (up to ${WAIT_BACKUP})"
	wait_for_jsonpath "${E2E_NAMESPACE}" backups.postgresql.cnpg.io e2e-backup-ok '{.status.phase}' completed "${WAIT_BACKUP%s}"
	wait_for_jsonpath "${E2E_NAMESPACE}" backups.postgresql.cnpg.io e2e-backup-failed '{.status.phase}' failed "${WAIT_BACKUP%s}"

	# The immediate schedule creates its first backup on its own; the views need
	# it completed, with the label that points back to the schedule.
	log "waiting for the backup generated by e2e-immediate to complete (up to ${WAIT_BACKUP})"
	local deadline phases
	deadline=$(($(date +%s) + ${WAIT_BACKUP%s}))
	while :; do
		phases="$(kubectl_e2e get backups.postgresql.cnpg.io --namespace "${E2E_NAMESPACE}" \
			-l cnpg.io/scheduled-backup=e2e-immediate -o 'jsonpath={.items[*].status.phase}' 2>/dev/null)"
		if [[ " ${phases} " == *" completed "* ]]; then
			break
		fi
		[[ "$(date +%s)" -ge ${deadline} ]] && die "no completed backup from e2e-immediate (phases: ${phases:-none})"
		sleep 5
	done

	log "waiting for the pooler"
	wait_rollout "${E2E_NAMESPACE}" e2e-main-pooler
}

hibernate_and_fence() {
	# Two states the operator produces only on request: a hibernated cluster
	# (no pods, PVCs kept) and a fenced instance (pod kept, PostgreSQL stopped).
	log "hibernating e2e-hibernated"
	kubectl_e2e annotate clusters.postgresql.cnpg.io e2e-hibernated --namespace "${E2E_NAMESPACE}" \
		--overwrite cnpg.io/hibernation=on >/dev/null
	local deadline pods
	deadline=$(($(date +%s) + 300))
	while :; do
		pods="$(kubectl_e2e get pods --namespace "${E2E_NAMESPACE}" -l cnpg.io/cluster=e2e-hibernated --no-headers 2>/dev/null | wc -l | tr -d ' ')"
		[[ ${pods} == "0" ]] && break
		[[ "$(date +%s)" -ge ${deadline} ]] && die "e2e-hibernated still has ${pods} pod(s) after hibernation"
		sleep 5
	done

	log "fencing the instance of e2e-fenced"
	kubectl_e2e annotate clusters.postgresql.cnpg.io e2e-fenced --namespace "${E2E_NAMESPACE}" \
		--overwrite 'cnpg.io/fencedInstances=["e2e-fenced-1"]' >/dev/null
	# `status.readyInstances` is omitted from the JSON when it drops to zero, so
	# the wait reads the instance pod's own Ready condition instead.
	wait_for_jsonpath "${E2E_NAMESPACE}" pod e2e-fenced-1 '{.status.conditions[?(@.type=="Ready")].status}' False 300
}

apply_declarative() {
	# The declarative databases, roles, publications and subscriptions
	# (SPEC-0013 to SPEC-0015). They come after the hibernation on purpose: the
	# database declared on e2e-hibernated must find no primary to apply it.
	# Logical replication does not carry the schema, so the replicated table is
	# created on both sides first, with fixed statements.
	local name primary
	for name in e2e-main e2e-single; do
		primary="$(kubectl_e2e get clusters.postgresql.cnpg.io "${name}" --namespace "${E2E_NAMESPACE}" -o 'jsonpath={.status.currentPrimary}')"
		log "creating the replicated table in the app database of ${name} (${primary})"
		kubectl_e2e exec --namespace "${E2E_NAMESPACE}" "${primary}" -c postgres -- \
			psql -U postgres -d app -v ON_ERROR_STOP=1 -Atc \
			'SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS e2e_numbers (i integer PRIMARY KEY, m integer); ALTER TABLE e2e_numbers OWNER TO app;' >/dev/null
	done
	primary="$(kubectl_e2e get clusters.postgresql.cnpg.io e2e-main --namespace "${E2E_NAMESPACE}" -o 'jsonpath={.status.currentPrimary}')"
	kubectl_e2e exec --namespace "${E2E_NAMESPACE}" "${primary}" -c postgres -- \
		psql -U postgres -d app -v ON_ERROR_STOP=1 -Atc \
		'INSERT INTO e2e_numbers (i, m) SELECT g, g * 2 FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING;' >/dev/null

	log "applying the databases, the roles, the publications and the subscriptions"
	kubectl_e2e apply -f "${E2E_FIXTURES_DIR}"/70-databases.yaml \
		-f "${E2E_FIXTURES_DIR}"/75-logical-replication.yaml >/dev/null

	log "waiting for the declarative objects to be applied or to fail as the fixtures intend"
	local kind object expected
	while read -r kind object expected; do
		wait_for_jsonpath "${E2E_NAMESPACE}" "${kind}.postgresql.cnpg.io" "${object}" '{.status.applied}' "${expected}" 300
	done <<-'STATES'
		databases e2e-db-inventory true
		databases e2e-db-absent true
		databases e2e-db-no-owner false
		databases e2e-db-bad-extension false
		databases e2e-db-inventory-again false
		databaseroles e2e-main-app true
		databaseroles e2e-role-reporting true
		databaseroles e2e-role-contractor true
		databaseroles e2e-role-batch false
		databaseroles e2e-role-inline-rival false
		publications e2e-pub-numbers true
		publications e2e-pub-all true
		publications e2e-pub-missing-table false
		subscriptions e2e-sub-numbers true
		subscriptions e2e-sub-no-publisher false
	STATES
	# The client certificate of the reporting role is issued by the operator a
	# moment after the role is applied.
	wait_for_nonempty_jsonpath "${E2E_NAMESPACE}" databaseroles.postgresql.cnpg.io e2e-role-reporting \
		'{.status.clientCertificate.expiration}' 300
}

wait_failover_quorum() {
	# e2e-main runs with the failover quorum on (SPEC-0011): its FailoverQuorum
	# object is written by the primary once the synchronous configuration is
	# loaded. On a cluster created with that configuration this takes seconds.
	# On a cluster that was already running when the configuration arrived,
	# operator 1.30.0 was seen to write the new settings to disk and then fail
	# its reconciliation before reloading them; one reload unblocks it.
	log "waiting for the failover quorum of e2e-main"
	local attempt names primary
	for attempt in 1 2; do
		local deadline=$(($(date +%s) + 120))
		while :; do
			names="$(kubectl_e2e get failoverquorums.postgresql.cnpg.io e2e-main --namespace "${E2E_NAMESPACE}" \
				-o 'jsonpath={.status.standbyNames}' 2>/dev/null || true)"
			if [[ -n ${names} ]] && [[ ${names} != "[]" ]]; then
				return
			fi
			[[ "$(date +%s)" -ge ${deadline} ]] && break
			sleep 5
		done
		[[ ${attempt} == "2" ]] && die "the FailoverQuorum of e2e-main was never written"
		primary="$(kubectl_e2e get clusters.postgresql.cnpg.io e2e-main --namespace "${E2E_NAMESPACE}" -o 'jsonpath={.status.currentPrimary}')"
		log "the quorum is still empty: reloading the configuration of ${primary} once"
		kubectl_e2e exec --namespace "${E2E_NAMESPACE}" "${primary}" -c postgres -- \
			psql -U postgres -Atc 'select pg_reload_conf()' >/dev/null
	done
}

verify_fixtures() {
	log "verifying the fixture states"
	local phase
	phase="$(kubectl_e2e get clusters.postgresql.cnpg.io e2e-main --namespace "${E2E_NAMESPACE}" -o 'jsonpath={.status.phase}')"
	[[ ${phase} == "${E2E_HEALTHY_PHASE}" ]] || die "e2e-main is not healthy: ${phase}"
	# The broken store must make the archiving of e2e-single fail, which is the
	# state the WAL archiving views distinguish.
	wait_for_jsonpath "${E2E_NAMESPACE}" clusters.postgresql.cnpg.io e2e-single \
		'{.status.conditions[?(@.type=="ContinuousArchiving")].status}' False 300
	log "fixture states verified"
}

main() {
	require_docker
	require_command kind kubectl curl
	mkdir -p "${E2E_STATE_DIR}"
	create_cluster
	install_cert_manager
	install_operator
	install_barman_plugin
	apply_fixtures
	wait_clusters
	wait_failover_quorum
	apply_second_phase
	hibernate_and_fence
	apply_declarative
	verify_fixtures
	log "cluster ready: kubeconfig=${E2E_KUBECONFIG} context=${E2E_KUBE_CONTEXT}"
}

main "$@"
