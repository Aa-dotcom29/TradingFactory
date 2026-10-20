#!/usr/bin/env bash
#
# One-command deployment of Trading Factory on Oracle Cloud Always Free.
#
# Creates (or reuses) the ARM VM, reserves its public IP, opens the ports the dashboard needs,
# then hands the machine to scripts/oracle-host-bootstrap.sh over SSH: Docker, the repo, .env,
# a TLS certificate for the IP, the stack, and the first household login.
#
# RUN IT IN ORACLE CLOUD SHELL
#   Cloud Shell already has an authenticated `oci` CLI and `jq`, so nothing needs installing:
#
#     git clone --branch slice-0-harness-backbone \
#       https://github.com/Aa-dotcom29/TradingFactory.git
#     cd TradingFactory
#     tmux new -s tf          # optional but recommended: the launch retry can run for hours
#     ./scripts/oracle-deploy.sh --owner-email you@example.com
#
#   It asks for the Angel One and Telegram credentials unless you pass --env-file with a copy of
#   your local .env (Cloud Shell has an upload button for exactly this).
#
# WHAT IT WILL NOT DO
#   - Register the IP with Angel One. That is a console action tied to your account, and it must
#     happen AFTER the reserved IP exists - which this script guarantees by creating it first.
#   - Change the risk limits. They live in config_registry, by design.
#   - Flip publishing to live. The stack starts in shadow.
#
# SAFETY RAIL
#   Always Free Ampere A1 is 2 OCPU / 12 GB as of 15 June 2026, and from 18 August 2026 Oracle
#   TERMINATES Always Free instances above that ceiling. The rail is enforced here before any
#   network call, so a typo cannot cost you the instance weeks later.
#
# COMMANDS
#   deploy      provision if needed, then bootstrap the host (default)
#   provision   create or reuse the VM and reserve its public IP, stop there
#   status      show the instance state from the inventory and whether the dashboard answers
#   ssh         open a shell on the instance
#
# OPTIONS
#   --compartment NAME|OCID  default: the tenancy root from ~/.oci/config
#   --subnet NAME|OCID       default: first public subnet of the first VCN in the compartment
#   --image OCID             default: newest Ubuntu 22.04/24.04 or Oracle Linux 9 image for the shape
#   --os ubuntu|oraclelinux  default ubuntu (no SELinux to fight on bind mounts)
#   --shape SHAPE            default VM.Standard.A1.Flex
#   --ocpus N                default 2      (Always Free ceiling: 2)
#   --memory GB              default 12     (Always Free ceiling: 12)
#   --boot-volume GB         default 50     (OCI minimum: 47)
#   --name NAME              default tradingfactory
#   --ssh-key PATH           default ~/.ssh/tf_oracle (generated when absent)
#   --repo URL               default https://github.com/Aa-dotcom29/TradingFactory.git
#   --branch NAME            default slice-0-harness-backbone
#   --env-file PATH          local .env with Angel One / Telegram secrets
#   --owner-email EMAIL      create this household login and print its password once
#   --tls / --no-tls         default on: the production session cookie is Secure
#   --open-ports LIST        default 22,80,443 (tls) or 22,3000 (--no-tls)
#   --no-open-ports          leave the security list alone
#   --ballast-gb N           opt-in RAM ballast against Oracle's idle reclamation (default 0)
#   --instance OCID          reuse a specific instance instead of looking one up
#   --new                    never reuse; always launch
#   --attempts N             launch attempts before giving up (0 = keep trying, default)
#   --sleep SECONDS          pause between rounds (default 180)
#   --degrade-after N        after N rounds at the full size, retry at 1 OCPU / 6 GB (default 3)
#   --inventory PATH         default ./oracle-inventory.env
#   --non-interactive        never prompt; missing secrets are left empty with a warning
#   --dry-run                resolve and print the plan, change nothing
#   --help
#
# EXIT CODES
#   0 done, 1 understood but could not do it, 2 bad invocation.

set -uo pipefail

COMPARTMENT="${COMPARTMENT:-}"
SUBNET="${SUBNET:-}"
IMAGE_OCID="${IMAGE_OCID:-}"
OS_KIND="${OS_KIND:-ubuntu}"
OS_SET=0
SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCPUS:-2}"
MEMORY_GB="${MEMORY_GB:-12}"
BOOT_VOLUME_GB="${BOOT_VOLUME_GB:-50}"
DISPLAY_NAME="${DISPLAY_NAME:-tradingfactory}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tf_oracle}"
REPO_URL="${REPO_URL:-https://github.com/Aa-dotcom29/TradingFactory.git}"
BRANCH="${BRANCH:-slice-0-harness-backbone}"
ENV_FILE="${ENV_FILE:-}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
TLS=1
OPEN_PORTS=""
OPEN_PORTS_SET=0
BALLAST_GB="${BALLAST_GB:-0}"
INSTANCE_OCID="${INSTANCE_OCID:-}"
NEVER_REUSE=0
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"
SLEEP_SECONDS="${SLEEP_SECONDS:-180}"
DEGRADE_AFTER="${DEGRADE_AFTER:-3}"
INVENTORY="${INVENTORY:-./oracle-inventory.env}"
NON_INTERACTIVE=0
DRY_RUN=0
COMMAND="deploy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

RAIL_ERROR=""

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'FAIL: %s\n  (try --help)\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
}

is_number() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The Always Free rail. Prints the reason into RAIL_ERROR and returns 1 when the request is unsafe.
rail_check() {
  local shape="$1" ocpus="$2" mem="$3" boot="$4"
  RAIL_ERROR=""
  if [[ "$shape" == *A1.Flex ]]; then
    if ((ocpus > 2)); then
      RAIL_ERROR="${shape} at ${ocpus} OCPU exceeds the Always Free ceiling of 2 OCPU.
  Oracle terminates Always Free instances above 2 OCPU / 12 GB (enforced 18 Aug 2026).
  Use --ocpus 2 --memory 12."
      return 1
    fi
    if ((mem > 12)); then
      RAIL_ERROR="${shape} at ${mem} GB exceeds the Always Free ceiling of 12 GB.
  Oracle terminates Always Free instances above 2 OCPU / 12 GB (enforced 18 Aug 2026).
  Use --ocpus 2 --memory 12."
      return 1
    fi
  fi
  if ((boot < 47)); then
    RAIL_ERROR="boot volume must be at least 47 GB (the OCI minimum), got ${boot}"
    return 1
  fi
  return 0
}

# "22,80,443" -> "22 80 443", rejecting anything that is not a TCP port. Duplicates are collapsed so
# the security-list merge cannot add the same rule twice.
normalize_ports() {
  local list="${1:-}" item out=""
  local IFS=','
  for item in $list; do
    item="${item//[[:space:]]/}"
    [[ -n "$item" ]] || continue
    if ! is_number "$item" || ((item < 1 || item > 65535)); then
      return 1
    fi
    case " $out " in
      *" $item "*) ;;
      *) out="${out:+$out }${item}" ;;
    esac
  done
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

ssh_user_for_os() {
  case "$1" in
    ubuntu) printf 'ubuntu' ;;
    oraclelinux) printf 'opc' ;;
    *) return 1 ;;
  esac
}

inventory_get() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

inventory_write() {
  local file="$1" instance="$2" ip="$3" compartment="$4" subnet="$5" ssh_user="${6:-$(ssh_user_for_os "$OS_KIND")}"
  {
    echo "# Generated by scripts/oracle-deploy.sh - do not commit this file."
    echo "INSTANCE_OCID=${instance}"
    echo "PUBLIC_IP=${ip}"
    echo "SSH_KEY=${SSH_KEY}"
    echo "SSH_USER=${ssh_user}"
    echo "COMPARTMENT_OCID=${compartment}"
    echo "SUBNET_OCID=${subnet}"
    echo "DISPLAY_NAME=${DISPLAY_NAME}"
    echo "CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$file"
  chmod 600 "$file"
}

# --- arguments -------------------------------------------------------------------------------

while (($#)); do
  case "$1" in
    deploy | provision | status | ssh) COMMAND="$1" ;;
    --compartment) COMPARTMENT="${2:-}"; shift ;;
    --subnet) SUBNET="${2:-}"; shift ;;
    --image) IMAGE_OCID="${2:-}"; shift ;;
    --os) OS_KIND="${2:-}"; OS_SET=1; shift ;;
    --shape) SHAPE="${2:-}"; shift ;;
    --ocpus) OCPUS="${2:-}"; shift ;;
    --memory) MEMORY_GB="${2:-}"; shift ;;
    --boot-volume) BOOT_VOLUME_GB="${2:-}"; shift ;;
    --name) DISPLAY_NAME="${2:-}"; shift ;;
    --ssh-key) SSH_KEY="${2:-}"; shift ;;
    --repo) REPO_URL="${2:-}"; shift ;;
    --branch) BRANCH="${2:-}"; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    --owner-email) OWNER_EMAIL="${2:-}"; shift ;;
    --tls) TLS=1 ;;
    --no-tls) TLS=0 ;;
    --open-ports) OPEN_PORTS="${2:-}"; OPEN_PORTS_SET=1; shift ;;
    --no-open-ports) OPEN_PORTS_SET=-1 ;;
    --ballast-gb) BALLAST_GB="${2:-}"; shift ;;
    --instance) INSTANCE_OCID="${2:-}"; shift ;;
    --new) NEVER_REUSE=1 ;;
    --attempts) MAX_ATTEMPTS="${2:-}"; shift ;;
    --sleep) SLEEP_SECONDS="${2:-}"; shift ;;
    --degrade-after) DEGRADE_AFTER="${2:-}"; shift ;;
    --inventory) INVENTORY="${2:-}"; shift ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help | -h) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

for pair in "ocpus:${OCPUS}" "memory:${MEMORY_GB}" "boot-volume:${BOOT_VOLUME_GB}" \
  "attempts:${MAX_ATTEMPTS}" "sleep:${SLEEP_SECONDS}" "degrade-after:${DEGRADE_AFTER}" \
  "ballast-gb:${BALLAST_GB}"; do
  is_number "${pair#*:}" || usage_error "--${pair%%:*} must be a whole number, got '${pair#*:}'"
done
case "$OS_KIND" in
  ubuntu | oraclelinux) ;;
  *) usage_error "--os must be ubuntu or oraclelinux, got '${OS_KIND}'" ;;
esac
rail_check "$SHAPE" "$OCPUS" "$MEMORY_GB" "$BOOT_VOLUME_GB" || die "$RAIL_ERROR"
[[ -n "$REPO_URL" ]] || usage_error "--repo is required"
[[ -n "$BRANCH" ]] || usage_error "--branch is required"

if ((OPEN_PORTS_SET == 0)); then
  if ((TLS == 1)); then OPEN_PORTS="22,80,443"; else OPEN_PORTS="22,3000"; fi
fi
if ((OPEN_PORTS_SET != -1)); then
  OPEN_PORTS="$(normalize_ports "$OPEN_PORTS")" || usage_error "--open-ports must be a comma-separated list of TCP ports"
fi

# --- OCI helpers -----------------------------------------------------------------------------

need_oci() {
  command -v oci >/dev/null 2>&1 || die "the 'oci' CLI is not on PATH.
  Run this in Oracle Cloud Shell, or install oci-cli and create ~/.oci/config."
  command -v jq >/dev/null 2>&1 || die "jq is required. Cloud Shell has it; on a laptop install jq."
}

tenancy_ocid() {
  local cfg="${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}"
  [[ -f "$cfg" ]] || return 1
  awk -F= 'tolower($1) ~ /^[[:space:]]*tenancy[[:space:]]*$/ { gsub(/[[:space:]]/, "", $2); print $2; exit }' "$cfg"
}

resolve_compartment() {
  local want="$1"
  if [[ -z "$want" ]]; then
    local tenancy
    tenancy="$(tenancy_ocid || true)"
    [[ -n "$tenancy" ]] || die "could not find the tenancy in ~/.oci/config; pass --compartment"
    warn "no --compartment given; using the tenancy root (${tenancy})"
    printf '%s' "$tenancy"
    return 0
  fi
  case "$want" in
    ocid1.*) printf '%s' "$want"; return 0 ;;
  esac
  local tenancy id
  tenancy="$(tenancy_ocid || true)"
  [[ -n "$tenancy" ]] || die "could not read the tenancy from ~/.oci/config; pass the compartment OCID"
  id="$(oci iam compartment list --compartment-id "$tenancy" --compartment-id-in-subtree true --all \
    | jq -r --arg n "$want" '.data[] | select(.name == $n) | .id' | head -n 1)"
  [[ -n "$id" ]] || die "no compartment named '${want}' in this tenancy; pass the OCID instead"
  printf '%s' "$id"
}

resolve_subnet() {
  local compartment="$1" want="$2"
  if [[ -n "$want" ]]; then
    case "$want" in
      ocid1.subnet.*) printf '%s' "$want"; return 0 ;;
      ocid1.*) printf '%s' "$want"; return 0 ;;
    esac
    local by_name
    by_name="$(oci network subnet list --compartment-id "$compartment" --all \
      | jq -r --arg n "$want" '.data[] | select(."display-name" == $n) | .id' | head -n 1)"
    [[ -n "$by_name" ]] || die "no subnet named '${want}' in the compartment"
    printf '%s' "$by_name"
    return 0
  fi
  local vcn
  vcn="$(oci network vcn list --compartment-id "$compartment" --all \
    | jq -r '.data | sort_by(."time-created") | .[0].id // empty')"
  [[ -n "$vcn" ]] || die "no VCN found in the compartment; create one or pass --subnet"
  local subnet
  subnet="$(oci network subnet list --compartment-id "$compartment" --vcn-id "$vcn" --all \
    | jq -r '.data | map(select(."prohibit-public-ip-on-vnic" == false)) | sort_by(."time-created") | .[0].id // empty')"
  [[ -n "$subnet" ]] || die "no public subnet in the VCN; pass --subnet"
  printf '%s' "$subnet"
}

resolve_image() {
  local compartment="$1"
  if [[ -n "$IMAGE_OCID" ]]; then
    printf '%s' "$IMAGE_OCID"
    return 0
  fi
  local os_name version_re
  case "$OS_KIND" in
    ubuntu) os_name="Canonical Ubuntu"; version_re='^(22\.04|24\.04)' ;;
    oraclelinux) os_name="Oracle Linux"; version_re='^9' ;;
  esac
  local id
  id="$(oci compute image list --compartment-id "$compartment" --operating-system "$os_name" \
    --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all \
    | jq -r --arg re "$version_re" \
      '.data | map(select((."operating-system-version" // "") | test($re))) | .[0].id // empty')"
  if [[ -z "$id" ]]; then
    id="$(oci compute image list --compartment-id "$compartment" --operating-system "$os_name" \
      --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all \
      | jq -r '.data[0].id // empty')"
  fi
  [[ -n "$id" ]] || die "could not resolve a ${os_name} image for ${SHAPE}; pass --image"
  printf '%s' "$id"
}

resolve_ads() {
  if [[ -n "${AD_LIST:-}" ]]; then
    printf '%s' "$AD_LIST" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d'
    return 0
  fi
  oci iam availability-domain list --compartment-id "$1" \
    | jq -r '.data[].name'
}

instance_private_ip_id() {
  local vnic_id
  vnic_id="$(oci compute instance list-vnics --instance-id "$1" \
    | jq -r '.data[0].id // empty')"
  [[ -n "$vnic_id" ]] || return 1
  oci network private-ip list --vnic-id "$vnic_id" \
    | jq -r '.data[0].id // empty'
}

find_instance() {
  oci compute instance list --compartment-id "$1" --display-name "$DISPLAY_NAME" --all \
    | jq -r '.data | map(select(."lifecycle-state" == "RUNNING")) | sort_by(."time-created") | .[-1].id // empty'
}

ensure_reserved_ip() {
  local instance="$1" compartment="$2" private_id existing
  RESERVED_IP=""
  private_id="$(instance_private_ip_id "$instance")" || die "could not find the instance's primary private IP"
  [[ -n "$private_id" ]] || die "could not find the instance's primary private IP"
  existing="$(oci network public-ip list --compartment-id "$compartment" --scope REGION --all \
    | jq -r --arg p "$private_id" '.data[] | select(."private-ip-id" == $p and .lifetime == "RESERVED") | .id' | head -n 1)"
  if [[ -n "$existing" ]]; then
    log "instance already has a reserved public IP; reusing it"
    RESERVED_IP="$(oci network public-ip get --public-ip-id "$existing" | jq -r '.data."ip-address"')"
    return 0
  fi
  local ip_id
  ip_id="$(oci network public-ip create --compartment-id "$compartment" --lifetime RESERVED \
    --private-ip-id "$private_id" --display-name "${DISPLAY_NAME}-ip" \
    | jq -r '.data.id // empty')"
  [[ -n "$ip_id" ]] || die "could not create the reserved public IP"
  RESERVED_IP="$(oci network public-ip get --public-ip-id "$ip_id" | jq -r '.data."ip-address"')"
}

# Adds the dashboard ports to every security list attached to the subnet. Rules already covering a
# port are left alone, so running this twice changes nothing. A subnet that uses network security
# groups instead is reported, not guessed at.
open_firewall_ports() {
  local subnet="$1" ports_csv="$2"
  local sls
  sls="$(oci network subnet get --subnet-id "$subnet" | jq -r '(.data."security-list-ids" // [])[]')"
  if [[ -z "$sls" ]]; then
    warn "the subnet uses network security groups, not security lists; open ${ports_csv} yourself"
    return 0
  fi
  local ports_json sl_id current updated
  ports_json="$(jq -Rn --arg s "$ports_csv" '$s | split(" ") | map(tonumber)')"
  while IFS= read -r sl_id; do
    sl_id="${sl_id//\"/}"
    [[ -n "$sl_id" ]] || continue
    if ((DRY_RUN)); then
      echo "  oci network security-list update --security-list-id ${sl_id} --ingress-security-rules <merged ${ports_csv}>"
      continue
    fi
    current="$(oci network security-list get --security-list-id "$sl_id" \
      | jq -c '.data."ingress-security-rules" // [] | walk(if type == "object" then with_entries(select(.value != null)) else . end)')"
    updated="$(printf '%s' "$current" | jq -c --argjson ports "$ports_json" '
      reduce $ports[] as $p (.;
        if any(.[]; .protocol == "6"
                 and ((."tcp-options"."destination-port-range".min // -1) <= $p)
                 and ((."tcp-options"."destination-port-range".max // -1) >= $p))
        then .
        else . + [{
          protocol: "6",
          source: "0.0.0.0/0",
          "is-stateless": false,
          description: "Trading Factory deploy",
          "tcp-options": { "destination-port-range": { min: $p, max: $p } }
        }]
        end)')"
    if [[ "$updated" == "$current" ]]; then
      log "security list already allows ${ports_csv}"
      continue
    fi
    oci network security-list update --security-list-id "$sl_id" \
      --ingress-security-rules "$updated" >/dev/null \
      || die "could not update security list ${sl_id}"
    log "opened ${ports_csv} on security list ${sl_id}"
  done <<<"$sls"
}

# --- launch ----------------------------------------------------------------------------------

# Sets LAUNCHED_INSTANCE. Progress goes to stdout, so the id must not: a caller capturing stdout
# would otherwise capture the log lines too.
launch_instance() {
  local compartment="$1" subnet="$2" image="$3" metadata_file="$4"
  shift 4
  local ads=("$@")
  local ocpus="$OCPUS" mem="$MEMORY_GB" attempt=0 round=0 ad output status instance=""
  LAUNCHED_INSTANCE=""

  while :; do
    round=$((round + 1))
    if ((DEGRADE_AFTER > 0 && round > DEGRADE_AFTER)) && [[ "$SHAPE" == *A1.Flex ]] \
      && ((ocpus == 2)); then
      ocpus=1
      mem=6
      warn "round ${round}: still no capacity at 2/12, retrying at 1 OCPU / 6 GB (inside the free allowance)"
    fi
    for ad in "${ads[@]}"; do
      [[ -n "$ad" ]] || continue
      if ((MAX_ATTEMPTS > 0 && attempt >= MAX_ATTEMPTS)); then
        break 2
      fi
      attempt=$((attempt + 1))
      log "attempt ${attempt} (round ${round}): ${ad} at ${ocpus} OCPU / ${mem} GB"
      if ((DRY_RUN)); then
        echo "  oci compute instance launch --availability-domain ${ad} --shape ${SHAPE} \\"
        echo "    --shape-config {\"ocpus\":${ocpus},\"memoryInGBs\":${mem}} --image-id ${image} \\"
        echo "    --subnet-id ${subnet} --boot-volume-size-in-gbs ${BOOT_VOLUME_GB} \\"
        echo "    --display-name ${DISPLAY_NAME} --assign-public-ip true --metadata file://${metadata_file}"
        instance="<instance-ocid>"
        break 2
      fi
      output="$(oci compute instance launch \
        --compartment-id "$compartment" \
        --availability-domain "$ad" \
        --shape "$SHAPE" \
        --shape-config "{\"ocpus\":${ocpus},\"memoryInGBs\":${mem}}" \
        --image-id "$image" \
        --subnet-id "$subnet" \
        --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" \
        --display-name "$DISPLAY_NAME" \
        --assign-public-ip true \
        --freeform-tags '{"managed-by":"tradingfactory-deploy"}' \
        --metadata "file://${metadata_file}" \
        --wait-for-state RUNNING \
        --query 'data.id' --raw-output 2>&1)"
      status=$?
      if ((status == 0)) && [[ -n "$output" && "$output" != "null" ]]; then
        instance="$output"
        log "launched: ${instance}"
        break 2
      fi
      if printf '%s' "$output" | grep -qi 'capacity'; then
        log "  no capacity in ${ad}"
        continue
      fi
      printf '%s\n' "$output" | sed 's/^/    /' >&2
      die "launch failed for a reason retrying will not fix"
    done
    if ((MAX_ATTEMPTS > 0 && attempt >= MAX_ATTEMPTS)); then
      break
    fi
    log "no capacity in any availability domain; sleeping ${SLEEP_SECONDS}s"
    sleep "$SLEEP_SECONDS"
  done
  [[ -n "$instance" ]] || return 1
  LAUNCHED_INSTANCE="$instance"
}

render_provision_plan() {
  local compartment="$1" subnet="$2" image="$3"
  echo "PLAN"
  echo "  shape       : ${SHAPE} (${OCPUS} OCPU / ${MEMORY_GB} GB, boot ${BOOT_VOLUME_GB} GB)"
  echo "  image       : ${image}"
  echo "  name        : ${DISPLAY_NAME}"
  echo "  compartment : ${compartment}"
  echo "  subnet      : ${subnet}"
  echo "  public ip   : RESERVED"
  if ((OPEN_PORTS_SET != -1)); then
    echo "  open ports  : ${OPEN_PORTS} (0.0.0.0/0)"
  else
    echo "  open ports  : left untouched"
  fi
  echo "  inventory   : ${INVENTORY}"
}

# --- host bootstrap --------------------------------------------------------------------------

wait_for_ssh() {
  local host="$1" user="$2" known="$3" i
  for i in $(seq 1 60); do
    if ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$known" -o ConnectTimeout=8 \
      "${user}@${host}" true 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

ensure_ssh_key() {
  if [[ ! -f "$SSH_KEY" ]]; then
    [[ "$SSH_KEY" == *.pub ]] && die "SSH_KEY points at a .pub file; pass the private key path"
    mkdir -p "$(dirname "$SSH_KEY")"
    ssh-keygen -t ed25519 -N '' -C "tradingfactory@$(hostname)" -f "$SSH_KEY" >/dev/null \
      || die "could not generate ${SSH_KEY}"
    log "generated a new SSH key at ${SSH_KEY}"
  fi
  [[ -f "${SSH_KEY}.pub" ]] || die "the public half is missing: ${SSH_KEY}.pub"
}

quote_env_value() {
  # Compose treats an unquoted '#' as the start of a comment and splits on spaces.
  case "$1" in
    *[[:space:]#]*) printf '"%s"' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

assemble_env() {
  local out="$1"
  : >"$out"
  if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || die "--env-file not found: ${ENV_FILE}"
    cp "$ENV_FILE" "$out"
    # The file is usually uploaded from Windows, where the editor wrote CRLF. A trailing CR would
    # become part of every secret and break the Angel One login in a way that looks like a bad key.
    sed -i 's/\r$//' "$out"
  fi
  local key value
  for key in ANGEL_CLIENT_ID ANGEL_API_KEY ANGEL_PASSWORD ANGEL_TOTP_SECRET \
    TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    value="$(grep -E "^[[:space:]]*${key}=" "$out" | tail -n 1 | cut -d= -f2- || true)"
    if [[ -z "$value" && $NON_INTERACTIVE -eq 0 && -t 0 ]]; then
      printf '%s (leave blank to skip): ' "$key"
      read -r -s value
      printf '\n'
    fi
    if [[ -n "$value" ]]; then
      grep -v -E "^[[:space:]]*${key}=" "$out" >"${out}.tmp" || true
      printf '%s=%s\n' "$key" "$(quote_env_value "$value")" >>"${out}.tmp"
      mv "${out}.tmp" "$out"
    fi
  done
  # A host reachable from the internet must never keep the repository default database password.
  if ! grep -qE '^[[:space:]]*POSTGRES_PASSWORD=.+' "$out"; then
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-24)" >>"$out"
  fi
  # Shadow unless the supplied file already says otherwise: a deploy must not start broadcasting.
  if ! grep -qE '^[[:space:]]*PUBLISH_MODE=' "$out"; then
    printf 'PUBLISH_MODE=shadow\n' >>"$out"
  fi
  chmod 600 "$out"
}

bootstrap_host() {
  local host="$1" user="$2" known="$3"
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tf-bootstrap-XXXXXX")"
  # Expand now: the local variable is gone by the time the trap runs at exit.
  trap "rm -rf '${tmp}'" EXIT

  assemble_env "${tmp}/secrets.env"
  local remote_env="/tmp/tf-secrets.env" remote_script="/tmp/tf-bootstrap.sh"
  local script="${SCRIPT_DIR}/oracle-host-bootstrap.sh"
  if [[ ! -f "$script" ]]; then
    warn "local copy of oracle-host-bootstrap.sh not found; downloading it from GitHub"
    curl -fsSL "https://raw.githubusercontent.com/Aa-dotcom29/TradingFactory/${BRANCH}/scripts/oracle-host-bootstrap.sh" \
      -o "${tmp}/oracle-host-bootstrap.sh" || die "could not download the host bootstrap script"
    script="${tmp}/oracle-host-bootstrap.sh"
  fi

  if ((DRY_RUN)); then
    echo "  scp ${script} ${user}@${host}:${remote_script}"
    echo "  scp <secrets> ${user}@${host}:${remote_env}"
    echo "  ssh ${user}@${host} bash ${remote_script} --branch ${BRANCH} --public-host ${host} ..."
    return 0
  fi

  log "waiting for SSH on ${host}"
  wait_for_ssh "$host" "$user" "$known" || die "SSH did not come up on ${host} within 5 minutes"
  log "uploading the bootstrap script and secrets"
  scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
    "$script" "${user}@${host}:${remote_script}" || die "could not upload the bootstrap script"
  scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
    "${tmp}/secrets.env" "${user}@${host}:${remote_env}" || die "could not upload the secrets"

  local remote_args=(
    --repo-url "$REPO_URL"
    --branch "$BRANCH"
    --public-host "$host"
    --env-file "$remote_env"
    --ballast-gb "$BALLAST_GB"
  )
  ((TLS == 1)) || remote_args+=(--no-tls)
  [[ -n "$OWNER_EMAIL" ]] && remote_args+=(--owner-email "$OWNER_EMAIL")

  log "bootstrapping the host (Docker, repo, TLS, stack); this takes several minutes"
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
    -o ServerAliveInterval=30 "${user}@${host}" \
    "bash ${remote_script} ${remote_args[*]}" \
    || die "the host bootstrap failed; inspect the output above"
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" \
    "${user}@${host}" "rm -f ${remote_script} ${remote_env}" || true
}

# --- commands --------------------------------------------------------------------------------

cmd_provision() {
  need_oci
  local compartment subnet
  compartment="$(resolve_compartment "$COMPARTMENT")" || die "could not resolve the compartment"
  [[ -n "$compartment" ]] || die "could not resolve the compartment"
  subnet="$(resolve_subnet "$compartment" "$SUBNET")" || die "could not resolve the subnet"
  [[ -n "$subnet" ]] || die "could not resolve the subnet"
  log "compartment ${compartment}"
  log "subnet      ${subnet}"

  # A dry run resolves the tenancy (read-only) and prints the plan, then stops. It creates no key,
  # no instance, no IP and no inventory file.
  if ((DRY_RUN)); then
    local plan_image plan_ads
    plan_image="$(resolve_image "$compartment")" || die "could not resolve an image for ${SHAPE}"
    mapfile -t plan_ads < <(resolve_ads "$compartment")
    ((${#plan_ads[@]})) || die "no availability domains returned for the compartment"
    render_provision_plan "$compartment" "$subnet" "$plan_image"
    printf '  availability domains:\n'
    printf '    %s\n' "${plan_ads[@]}"
    echo "  ssh key     : $([[ -f "$SSH_KEY" ]] && echo exists || echo 'will be generated')"
    echo "  ssh metadata : <built at launch time from ${SSH_KEY}.pub>"
    launch_instance "$compartment" "$subnet" "$plan_image" "<metadata.json>" "${plan_ads[@]}" \
      || die "the plan could not be rendered"
    echo "  oci network public-ip create --compartment-id ${compartment} --lifetime RESERVED \\"
    echo "    --private-ip-id <primary private ip of the new instance> --display-name ${DISPLAY_NAME}-ip"
    echo "  then (deploy only): open ${OPEN_PORTS} on the security list and bootstrap the host"
    echo "    over SSH - Docker, the repo, .env, a TLS certificate, the stack, the first login"
    echo
    echo "Dry run complete. Nothing was created. Re-run without --dry-run to provision."
    return 0
  fi

  ensure_ssh_key

  local known="${HOME}/.ssh/known_hosts_tf"
  mkdir -p "$(dirname "$known")"
  touch "$known"

  local instance=""
  if [[ -n "$INSTANCE_OCID" ]]; then
    instance="$INSTANCE_OCID"
    log "reusing the instance passed with --instance"
  elif ((NEVER_REUSE == 0)); then
    instance="$(find_instance "$compartment" || true)"
    [[ -n "$instance" ]] && log "reusing the running instance named ${DISPLAY_NAME}: ${instance}"
  fi

  local image
  if [[ -z "$instance" ]]; then
    image="$(resolve_image "$compartment")" || die "could not resolve an image for ${SHAPE}"
    [[ -n "$image" ]] || die "could not resolve an image for ${SHAPE}"
    local ads
    mapfile -t ads < <(resolve_ads "$compartment")
    ((${#ads[@]})) || die "no availability domains returned for the compartment"

    local metadata
    metadata="$(mktemp "${TMPDIR:-/tmp}/tf-ssh-XXXXXX.json")"
    # The key travels in a file: it is long, and a shell-quoting slip here produces an instance
    # nobody can log into.
    printf '{"ssh_authorized_keys":"%s"}' "$(tr -d '\r\n' <"${SSH_KEY}.pub")" >"$metadata"
    launch_instance "$compartment" "$subnet" "$image" "$metadata" "${ads[@]}" \
      || die "no capacity: every availability domain refused. Re-run later, or try
  --ocpus 1 --memory 6, or the AMD micro fallback in docs/oracle-deploy.md."
    rm -f "$metadata"
    instance="${LAUNCHED_INSTANCE}"
    [[ -n "$instance" ]] || die "the launch produced no instance id"
  fi

  ensure_reserved_ip "$instance" "$compartment" || die "could not secure a reserved public IP"
  local ip="$RESERVED_IP"
  [[ -n "$ip" ]] || die "the instance has no public IP; is the subnet private?"
  log "public IP ${ip} (reserved)"

  # A reused instance keeps the login user it was built with. Defaulting to the current --os would
  # hand back a working address with the wrong username.
  local ssh_user
  ssh_user="$(ssh_user_for_os "$OS_KIND")"
  if ((OS_SET == 0)); then
    local prior_user
    prior_user="$(inventory_get "$INVENTORY" SSH_USER || true)"
    [[ -n "$prior_user" ]] && ssh_user="$prior_user"
  fi

  if ((OPEN_PORTS_SET != -1)); then
    open_firewall_ports "$subnet" "$OPEN_PORTS"
  fi

  inventory_write "$INVENTORY" "$instance" "$ip" "$compartment" "$subnet" "$ssh_user"
  log "inventory written to ${INVENTORY}"

  echo
  echo "Instance : ${instance}"
  echo "Address  : ${ip}"
  echo "SSH      : ssh -i ${SSH_KEY} ${ssh_user}@${ip}"
  echo
  echo "Register ${ip} as the SmartAPI primary IP for the Angel One app before the first login."
}

cmd_status() {
  [[ -f "$INVENTORY" ]] || die "no inventory at ${INVENTORY}; run 'provision' first or pass --inventory"
  local instance ip key scheme
  instance="$(inventory_get "$INVENTORY" INSTANCE_OCID || true)"
  ip="$(inventory_get "$INVENTORY" PUBLIC_IP || true)"
  key="$(inventory_get "$INVENTORY" SSH_KEY || true)"
  echo "instance : ${instance}"
  echo "address  : ${ip}"
  echo "key      : ${key}"
  if command -v oci >/dev/null 2>&1 && [[ -n "$instance" ]]; then
    echo "state    : $(oci compute instance get --instance-id "$instance" | jq -r '.data."lifecycle-state"')"
  fi
  if [[ -n "$ip" ]]; then
    scheme="$( { curl -ksf --max-time 5 "https://${ip}/" -o /dev/null && echo https; } \
      || { curl -sf --max-time 5 "http://${ip}:3000/" -o /dev/null && echo http; } \
      || true)"
    if [[ -n "$scheme" ]]; then
      echo "dashboard: ${scheme}://${ip}$([[ "$scheme" == "http" ]] && echo ':3000')/  (answering)"
    else
      echo "dashboard: not answering (is the stack up? ssh in and run docker compose ps)"
    fi
  fi
}

cmd_ssh() {
  [[ -f "$INVENTORY" ]] || die "no inventory at ${INVENTORY}; run 'provision' first"
  local ip key user
  ip="$(inventory_get "$INVENTORY" PUBLIC_IP || true)"
  key="$(inventory_get "$INVENTORY" SSH_KEY || true)"
  user="$(inventory_get "$INVENTORY" SSH_USER || true)"
  [[ -n "$ip" && -n "$key" ]] || die "the inventory is missing PUBLIC_IP or SSH_KEY"
  exec ssh -i "$key" -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="${HOME}/.ssh/known_hosts_tf" "${user:-ubuntu}@${ip}"
}

cmd_deploy() {
  # Provision always runs first so a re-run is safe: it reuses the instance and its reserved IP.
  cmd_provision
  ((DRY_RUN)) && return 0
  local ip user
  ip="$(inventory_get "$INVENTORY" PUBLIC_IP || true)"
  user="$(inventory_get "$INVENTORY" SSH_USER || true)"
  [[ -n "$ip" ]] || die "no PUBLIC_IP in ${INVENTORY}"
  bootstrap_host "$ip" "${user:-ubuntu}" "${HOME}/.ssh/known_hosts_tf"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "$COMMAND" in
    provision) cmd_provision ;;
    status) cmd_status ;;
    ssh) cmd_ssh ;;
    deploy) cmd_deploy ;;
  esac
fi
