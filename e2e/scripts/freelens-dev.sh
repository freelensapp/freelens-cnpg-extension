#!/usr/bin/env bash
#
# Freelens dev for the integration tests: a fresh profile under the system's
# temporary directory whose preferences sync the lab's kubeconfig alone, so
# that the app sees the kind cluster of `pnpm e2e:cluster:up` and none of the
# developer's clusters.
#
#   e2e/scripts/freelens-dev.sh                 write the profile and run `pnpm dev` of the Freelens checkout
#   e2e/scripts/freelens-dev.sh --profile-only  write the profile only (the CI workflow starts Freelens itself)
#
# The kubeconfig is the one of lib.sh (E2E_KUBECONFIG, under E2E_STATE_DIR):
# `E2E_CLUSTER_NAME=cnpg-demo E2E_STATE_DIR=.demo` points it at the demo
# cluster of `pnpm demo:up` for `pnpm pre-review`.
#
# Env: FREELENS_DIR, the freelensapp/freelens checkout (default: ../freelens);
# FREELENS_INTEGRATION_TESTING_DIR, the profile (default:
# /tmp/freelens-cnpg-integration); THEME=Dark|Light.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

profile="${FREELENS_INTEGRATION_TESTING_DIR:-/tmp/freelens-cnpg-integration}"
freelens="${FREELENS_DIR:-${REPO_ROOT}/../freelens}"

[[ -f ${E2E_KUBECONFIG} ]] || die "no lab kubeconfig at ${E2E_KUBECONFIG}: run 'pnpm e2e:cluster:up' first"
if grep -E '^\s*server:' "${E2E_KUBECONFIG}" | grep -vqE 'https://(127\.0\.0\.1|localhost|\[::1\]):'; then
  die "refusing ${E2E_KUBECONFIG}: it names a server that is not local"
fi
case "${profile}" in
  /tmp/?*) ;;
  *) die "refusing profile ${profile}: Freelens accepts FREELENS_INTEGRATION_TESTING_DIR under /tmp only" ;;
esac

rm -rf "${profile}"
for app in FreelensDev Freelens; do
  mkdir -p "${profile}/${app}"
  node - "${profile}/${app}/lens-user-store.json" "${E2E_KUBECONFIG}" <<'NODE'
const fs = require("node:fs");
const [storePath, kubeconfig] = process.argv.slice(2);
const preferences = { allowErrorReporting: false, syncKubeconfigEntries: [{ filePath: kubeconfig }] };
if (process.env.THEME) preferences.colorTheme = process.env.THEME;
fs.writeFileSync(storePath, `${JSON.stringify({ preferences }, null, 2)}\n`, { mode: 0o600 });
NODE
done
log "profile ${profile} syncs ${E2E_KUBECONFIG} only"

[[ ${1:-} == "--profile-only" ]] && exit 0
[[ -d ${freelens} ]] || die "no Freelens checkout at ${freelens}: set FREELENS_DIR"
cd "${freelens}"
export FREELENS_INTEGRATION_TESTING_DIR="${profile}"
exec pnpm dev
