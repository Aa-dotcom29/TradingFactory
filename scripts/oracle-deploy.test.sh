#!/usr/bin/env bash
#
# Offline checks for the Oracle deployment scripts. No network, no OCI tenancy, no Docker.
#
#   bash scripts/oracle-deploy.test.sh
#
# What it covers: the Always Free rail, port parsing, dotenv round-trips, the inventory file, the
# OS-to-ssh-user mapping, and the secret assembly. What it cannot cover: whether a given tenancy
# accepts a shape. That is what `oracle-deploy.sh --dry-run` is for.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL %s\n' "$1"
}

check() {
  local name="$1"
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

# Runs a helper in this shell and inverts it. `bash -c '! helper'` would not see the sourced
# functions and would pass for the wrong reason.
not() { ! "$@"; }

rail_message_names_ceiling() {
  rail_check VM.Standard.A1.Flex 4 12 50 && return 1
  [[ "$RAIL_ERROR" == *"2 OCPU"* ]]
}

# The scripts guard their main() so they can be sourced without running anything.
# shellcheck source=/dev/null
. "${HERE}/oracle-deploy.sh"
# shellcheck source=/dev/null
. "${HERE}/oracle-host-bootstrap.sh"

# --- syntax ----------------------------------------------------------------------------------

for f in oracle-deploy.sh oracle-host-bootstrap.sh oracle-a1-retry.sh; do
  check "syntax: ${f}" bash -n "${HERE}/${f}"
done

# --- number and port parsing -----------------------------------------------------------------

check "is_number accepts 12" is_number 12
check "is_number rejects an empty value" not is_number ""
check "is_number rejects '2 GB'" not is_number "2 GB"
check "is_number rejects a negative" not is_number "-1"

check "ports: 22,80,443" test "$(normalize_ports '22,80,443')" = "22 80 443"
check "ports: spaces and duplicates collapse" test "$(normalize_ports ' 22, 80,22 ')" = "22 80"
check "ports: reject 70000" not normalize_ports "70000"
check "ports: reject a non-number" not normalize_ports "ssh"
check "ports: reject an empty list" not normalize_ports ""

# --- the Always Free rail --------------------------------------------------------------------

check "rail allows 2 OCPU / 12 GB / 50 GB" rail_check VM.Standard.A1.Flex 2 12 50
check "rail refuses 3 OCPU" not rail_check VM.Standard.A1.Flex 3 12 50
check "rail refuses 13 GB" not rail_check VM.Standard.A1.Flex 2 13 50
check "rail refuses a 46 GB boot volume" not rail_check VM.Standard.A1.Flex 2 12 46
check "rail allows the smaller 1/6 request" rail_check VM.Standard.A1.Flex 1 6 50
check "rail names the ceiling when it refuses" rail_message_names_ceiling

# --- OS mapping ------------------------------------------------------------------------------

check "ubuntu user" test "$(ssh_user_for_os ubuntu)" = "ubuntu"
check "oracle linux user" test "$(ssh_user_for_os oraclelinux)" = "opc"
check "unknown os is rejected" not ssh_user_for_os windows

# --- dotenv round-trip -----------------------------------------------------------------------

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tf-scripts-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

env_set "${TMP}/.env" ALPHA one
env_set "${TMP}/.env" BETA "two words"
env_set "${TMP}/.env" ALPHA changed
env_set "${TMP}/.env" HASH "value#notacomment"

check "env_get reads a plain value" test "$(env_get "${TMP}/.env" ALPHA)" = "changed"
check "env_get strips quotes" test "$(env_get "${TMP}/.env" BETA)" = "two words"
check "env_get keeps a hash inside a value" test "$(env_get "${TMP}/.env" HASH)" = "value#notacomment"
check "env_set replaces instead of appending" test "$(grep -c '^ALPHA=' "${TMP}/.env")" = "1"
check "env_get on a missing key fails" not env_get "${TMP}/.env" MISSING

# --- inventory -------------------------------------------------------------------------------

SSH_KEY="/tmp/tf-test-key"
inventory_write "${TMP}/inventory.env" "ocid1.instance.oc1..abc" "203.0.113.7" \
  "ocid1.compartment.oc1..x" "ocid1.subnet.oc1..y"
check "inventory instance" test "$(inventory_get "${TMP}/inventory.env" INSTANCE_OCID)" = "ocid1.instance.oc1..abc"
check "inventory ip" test "$(inventory_get "${TMP}/inventory.env" PUBLIC_IP)" = "203.0.113.7"
check "inventory ssh user follows --os" test "$(inventory_get "${TMP}/inventory.env" SSH_USER)" = "ubuntu"

# Windows/MSYS does not honour POSIX modes, so the permission assertions only run on Linux. They
# are the ones that matter on the host: .env and the inventory hold secrets.
mode_of() { stat -c '%a' "$1" 2>/dev/null || echo unknown; }
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) check "inventory is mode 600" test "$(mode_of "${TMP}/inventory.env")" = "600" ;;
esac

# --- password and secret assembly ------------------------------------------------------------

pw="$(gen_password)"
check "generated password is 24 alphanumerics" bash -c "[[ '${pw}' =~ ^[A-Za-z0-9]{24}\$ ]]"

printf 'ANGEL_CLIENT_ID=client-abc\nPUBLISH_MODE=live\nDATABASE_URL=postgres://localhost/local\n' \
  >"${TMP}/local.env"
ENV_FILE="${TMP}/local.env"
NON_INTERACTIVE=1
assemble_env "${TMP}/secrets.env"
check "assembly keeps the supplied Angel client id" grep -q '^ANGEL_CLIENT_ID=client-abc$' "${TMP}/secrets.env"
check "assembly preserves a deliberate PUBLISH_MODE" grep -q '^PUBLISH_MODE=live$' "${TMP}/secrets.env"
check "assembly generates a database password" grep -qE '^POSTGRES_PASSWORD=.{20,}$' "${TMP}/secrets.env"
check "assembly never duplicates a key" test "$(grep -c '^PUBLISH_MODE=' "${TMP}/secrets.env")" = "1"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) check "secrets file is mode 600" test "$(mode_of "${TMP}/secrets.env")" = "600" ;;
esac

# --- host bootstrap: .env and certificate ----------------------------------------------------

APP_DIR="${TMP}/app"
mkdir -p "$APP_DIR"
cp "${HERE}/../.env.example" "${APP_DIR}/.env.example"
ENV_SRC=""
FORCE_ENV=0

write_env >/dev/null 2>&1
check "host .env is created" test -f "${APP_DIR}/.env"
check "host .env gets a generated database password" grep -qE '^POSTGRES_PASSWORD=.{20,}$' "${APP_DIR}/.env"
check "host .env clears DATABASE_URL" grep -qx 'DATABASE_URL=' "${APP_DIR}/.env"
check "host .env disables the dev auth bypass" grep -qx 'AUTH_DISABLED=false' "${APP_DIR}/.env"
check "host .env starts in shadow" grep -qx 'PUBLISH_MODE=shadow' "${APP_DIR}/.env"
check "host .env keeps the 90 day floor" grep -qx 'HARNESS_RETENTION_DAYS=90' "${APP_DIR}/.env"

pw_before="$(env_get "${APP_DIR}/.env" POSTGRES_PASSWORD)"
write_env >/dev/null 2>&1
check "a re-run keeps the database password" test "$pw_before" = "$(env_get "${APP_DIR}/.env" POSTGRES_PASSWORD)"

printf 'ANGEL_CLIENT_ID=abc\r\nPUBLISH_MODE=live\r\n' >"${TMP}/upload.env"
ENV_SRC="${TMP}/upload.env"
write_env >/dev/null 2>&1
check "an uploaded CRLF .env is normalised" grep -qx 'ANGEL_CLIENT_ID=abc' "${APP_DIR}/.env"
check "an uploaded PUBLISH_MODE is respected" grep -qx 'PUBLISH_MODE=live' "${APP_DIR}/.env"
check "the uploaded secret copy is removed" test ! -f "${TMP}/upload.env"
ENV_SRC=""

PUBLIC_HOST="203.0.113.10"
TLS=1
write_certs >/dev/null 2>&1
check "the certificate exists" test -s "${APP_DIR}/nginx/certs/tls.crt"
cert_has_san() { openssl x509 -in "${APP_DIR}/nginx/certs/tls.crt" -noout -text | grep -q "IP Address:${PUBLIC_HOST}"; }
check "the certificate carries the IP as a SAN" cert_has_san

# --- the shim --------------------------------------------------------------------------------

check "the old launcher still answers --help" bash -c "bash '${HERE}/oracle-a1-retry.sh' --help >/dev/null"
check "the deploy script answers --help" bash -c "bash '${HERE}/oracle-deploy.sh' --help | grep -q 'One-command deployment'"

rail_refuses_at_startup() {
  bash "${HERE}/oracle-deploy.sh" provision --ocpus 4 --memory 24 >/dev/null 2>&1 && return 1
  return 0
}
check "the rail fires before any network call" rail_refuses_at_startup

# --- summary ---------------------------------------------------------------------------------

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
((FAIL == 0))
