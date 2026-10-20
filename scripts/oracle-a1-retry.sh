#!/usr/bin/env bash
#
# Provision the Oracle Cloud Always Free ARM VM that runs Trading Factory, retrying across
# availability domains until capacity is granted.
#
# WHY THIS EXISTS
#   "Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1" is the normal
#   answer on a busy free tier, not a mistake you made. Capacity is granted per availability
#   domain and it appears and disappears through the day, so the practical fix is to keep asking,
#   rotating through the ADs, until one says yes.
#
# WHERE TO RUN IT
#   Oracle Cloud Shell. It has the `oci` CLI installed and already authenticated as you, so there
#   is nothing to install and no API key to create: open the Cloud Shell icon in the OCI console
#   and paste this in. A laptop works too, but needs `oci` plus ~/.oci/config.
#
# SAFETY RAIL - the reason this script is shaped the way it is
#   Always Free Ampere A1 is 2 OCPU / 12 GB, effective 15 June 2026. From 18 August 2026 Oracle
#   TERMINATES Always Free instances above that ceiling. Nearly every guide online still says
#   4 OCPU / 24 GB, and following one will cost you the instance. So the ceiling is enforced here,
#   in code, instead of being left to the caller to remember.
#
# NOT YET RUN AGAINST A LIVE TENANCY
#   The refusal rules and the plan output are exercised locally. The launch and reserved-IP steps
#   use the documented CLI shapes but have not been executed against Oracle from this repo. Run
#   with --dry-run first and read the commands it prints.
#
# USAGE
#   COMPARTMENT_OCID=... SUBNET_OCID=... ./scripts/oracle-a1-retry.sh --dry-run
#   COMPARTMENT_OCID=... SUBNET_OCID=... ./scripts/oracle-a1-retry.sh --reserve-ip
#
# ENVIRONMENT
#   COMPARTMENT_OCID  required. The compartment to create the instance in.
#   SUBNET_OCID       required. A public subnet in the VCN.
#   SSH_KEY_FILE      default ~/.ssh/id_ed25519.pub (the PUBLIC key).
#   SHAPE             default VM.Standard.A1.Flex.
#   OCPUS             default 2.   MEMORY_GB default 12.
#   BOOT_VOLUME_GB    default 50 (OCI minimum is 47).
#   DISPLAY_NAME      default tradingfactory.
#   IMAGE_OCID        optional; resolved from the platform image list if unset.
#   AD_LIST           optional comma-separated AD names; discovered if unset.
#   MAX_ATTEMPTS      default 0 (keep trying). SLEEP_SECONDS default 180 between rounds.

set -uo pipefail

COMPARTMENT_OCID="${COMPARTMENT_OCID:-}"
SUBNET_OCID="${SUBNET_OCID:-}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCPUS:-2}"
MEMORY_GB="${MEMORY_GB:-12}"
BOOT_VOLUME_GB="${BOOT_VOLUME_GB:-50}"
DISPLAY_NAME="${DISPLAY_NAME:-tradingfactory}"
IMAGE_OCID="${IMAGE_OCID:-}"
AD_LIST="${AD_LIST:-}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"
SLEEP_SECONDS="${SLEEP_SECONDS:-180}"

DRY_RUN=0
RESERVE_IP=0

usage() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# A bad invocation is a different thing from a refusal: exit 2 means "you called me wrong", exit 1
# means "I understood and would not do it". Scripts that wrap this one can tell them apart.
usage_error() {
  echo "FAIL: $*" >&2
  echo "  (try --help)" >&2
  exit 2
}

# Whole, non-negative integer only. Guards below compare arithmetically, so a value like "2 GB"
# would otherwise be treated as the number 2 and pass a ceiling check by accident.
is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --reserve-ip) RESERVE_IP=1 ;;
    --shape) SHAPE="${2:-}"; shift ;;
    --ocpus) OCPUS="${2:-}"; shift ;;
    --memory) MEMORY_GB="${2:-}"; shift ;;
    --boot-volume) BOOT_VOLUME_GB="${2:-}"; shift ;;
    --name) DISPLAY_NAME="${2:-}"; shift ;;
    --attempts) MAX_ATTEMPTS="${2:-}"; shift ;;
    --sleep) SLEEP_SECONDS="${2:-}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

is_number "$OCPUS" || usage_error "--ocpus must be a whole number, got '${OCPUS}'"
is_number "$MEMORY_GB" || usage_error "--memory must be a whole number, got '${MEMORY_GB}'"
is_number "$BOOT_VOLUME_GB" || usage_error "--boot-volume must be a whole number, got '${BOOT_VOLUME_GB}'"

# The rail. Deliberately checked before anything else touches the network, so a typo fails fast
# and loudly instead of creating an instance Oracle will terminate weeks later without warning.
if [[ "$SHAPE" == *A1.Flex ]]; then
  if ((OCPUS > 2)); then
    fail "$SHAPE at ${OCPUS} OCPU exceeds the Always Free ceiling of 2 OCPU.
  Oracle terminates Always Free instances above 2 OCPU / 12 GB (enforced 18 Aug 2026).
  Use --ocpus 2 --memory 12, or upgrade the tenancy to PAYG and change this check on purpose."
  fi
  if ((MEMORY_GB > 12)); then
    fail "$SHAPE at ${MEMORY_GB} GB exceeds the Always Free ceiling of 12 GB.
  Oracle terminates Always Free instances above 2 OCPU / 12 GB (enforced 18 Aug 2026).
  Use --ocpus 2 --memory 12, or upgrade the tenancy to PAYG and change this check on purpose."
  fi
fi

if ((BOOT_VOLUME_GB < 47)); then
  fail "boot volume must be at least 47 GB (the OCI minimum), got ${BOOT_VOLUME_GB}"
fi

[[ -n "$COMPARTMENT_OCID" ]] || usage_error "COMPARTMENT_OCID is required"
[[ -n "$SUBNET_OCID" ]] || usage_error "SUBNET_OCID is required"
[[ -f "$SSH_KEY_FILE" ]] || fail "SSH public key not found: ${SSH_KEY_FILE} (set SSH_KEY_FILE)"

if ! command -v oci >/dev/null 2>&1 && ((DRY_RUN == 0)); then
  fail "the 'oci' CLI is not on PATH. Use Oracle Cloud Shell, or install oci-cli."
fi

discover_ads() {
  if [[ -n "$AD_LIST" ]]; then
    printf '%s' "$AD_LIST" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d'
    return 0
  fi
  if ((DRY_RUN)); then
    printf '%s\n' '<AD-1 from your tenancy>' '<AD-2 from your tenancy>' '<AD-3 from your tenancy>'
    return 0
  fi
  oci iam availability-domain list \
    --compartment-id "$COMPARTMENT_OCID" \
    --query 'data[].name' --raw-output | tr -d '[]"' | tr ',' '\n' |
    sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d'
}

resolve_image() {
  if [[ -n "$IMAGE_OCID" ]]; then
    printf '%s' "$IMAGE_OCID"
    return 0
  fi
  oci compute image list \
    --compartment-id "$COMPARTMENT_OCID" \
    --operating-system "Oracle Linux" \
    --shape "$SHAPE" \
    --sort-by TIMECREATED --sort-order DESC \
    --query 'data[0].id' --raw-output
}

ads="$(discover_ads)"
[[ -n "$ads" ]] || fail "no availability domains found for the compartment"

if ((DRY_RUN)); then
  image="${IMAGE_OCID:-<latest Oracle Linux platform image for ${SHAPE}>}"
  echo "PLAN"
  echo "  shape       : ${SHAPE} (${OCPUS} OCPU / ${MEMORY_GB} GB, boot ${BOOT_VOLUME_GB} GB)"
  echo "  name        : ${DISPLAY_NAME}"
  echo "  image       : ${image}"
  echo "  compartment : ${COMPARTMENT_OCID}"
  echo "  subnet      : ${SUBNET_OCID}"
  echo "  ssh key     : ${SSH_KEY_FILE}"
  if ((RESERVE_IP)); then
    echo "  public ip   : create a RESERVED public ip after launch"
  else
    echo "  public ip   : ephemeral (not recommended - see docs/oracle-deploy.md)"
  fi
  echo "  attempts    : $([[ "$MAX_ATTEMPTS" == "0" ]] && echo 'until granted' || echo "$MAX_ATTEMPTS")"
  echo "  ADs, in order:"
  printf '    %s\n' $ads
  echo
  if [[ "$SHAPE" == *Flex* ]]; then
    echo "Per AD, until one succeeds:"
    echo "  oci compute instance launch \\"
    echo "    --availability-domain <AD> --shape ${SHAPE} \\"
    echo "    --shape-config '{\"ocpus\":${OCPUS},\"memoryInGBs\":${MEMORY_GB}}' \\"
    echo "    --image-id ${image} --subnet-id ${SUBNET_OCID} \\"
    echo "    --boot-volume-size-in-gbs ${BOOT_VOLUME_GB} --display-name ${DISPLAY_NAME} \\"
    echo "    --assign-public-ip true --metadata file://<ssh-key.json> --wait-for-state RUNNING"
  else
    echo "Per AD, until one succeeds:"
    echo "  oci compute instance launch \\"
    echo "    --availability-domain <AD> --shape ${SHAPE} \\"
    echo "    --image-id ${image} --subnet-id ${SUBNET_OCID} \\"
    echo "    --boot-volume-size-in-gbs ${BOOT_VOLUME_GB} --display-name ${DISPLAY_NAME} \\"
    echo "    --assign-public-ip true --metadata file://<ssh-key.json> --wait-for-state RUNNING"
  fi
  exit 0
fi

image="$(resolve_image)"
[[ -n "$image" ]] || fail "could not resolve an image for ${SHAPE}; pass IMAGE_OCID explicitly"

# The public key goes through a file rather than an inline JSON argument: keys are long, and a
# shell-quoting slip here would silently produce an instance you cannot log into.
metadata_file="$(mktemp "${TMPDIR:-/tmp}/tf-ssh-XXXXXX.json")"
trap 'rm -f "$metadata_file"' EXIT
printf '{"ssh_authorized_keys":"%s"}' "$(tr -d '\r\n' <"$SSH_KEY_FILE")" >"$metadata_file"

shape_args=()
if [[ "$SHAPE" == *Flex* ]]; then
  shape_args=(--shape-config "{\"ocpus\":${OCPUS},\"memoryInGBs\":${MEMORY_GB}}")
fi

instance_id=""
attempt=0
round=0

while :; do
  round=$((round + 1))
  while IFS= read -r ad; do
    [[ -n "$ad" ]] || continue
    if ((MAX_ATTEMPTS > 0 && attempt >= MAX_ATTEMPTS)); then
      break 2
    fi
    attempt=$((attempt + 1))
    echo "attempt ${attempt} (round ${round}): ${ad}"

    output="$(oci compute instance launch \
      --compartment-id "$COMPARTMENT_OCID" \
      --availability-domain "$ad" \
      --shape "$SHAPE" \
      "${shape_args[@]}" \
      --image-id "$image" \
      --subnet-id "$SUBNET_OCID" \
      --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" \
      --display-name "$DISPLAY_NAME" \
      --assign-public-ip true \
      --metadata "file://${metadata_file}" \
      --wait-for-state RUNNING \
      --query 'data.id' --raw-output 2>&1)"
    status=$?

    if ((status == 0)) && [[ -n "$output" ]]; then
      instance_id="$output"
      echo "launched: ${instance_id}"
      break 2
    fi

    if printf '%s' "$output" | grep -qi 'capacity'; then
      echo "  no capacity in ${ad}"
      continue
    fi

    echo "  launch failed for a reason retrying will not fix:" >&2
    printf '%s\n' "$output" | sed 's/^/    /' >&2
    exit 1
  done <<<"$ads"

  if ((MAX_ATTEMPTS > 0 && attempt >= MAX_ATTEMPTS)); then
    break
  fi
  echo "no capacity in any AD; sleeping ${SLEEP_SECONDS}s before round $((round + 1))"
  sleep "$SLEEP_SECONDS"
done

if [[ -z "$instance_id" ]]; then
  cat >&2 <<EOF
Gave up after ${attempt} attempt(s): no capacity in any availability domain.

The Always Free pool is genuinely contended, so this is not a bug in the script. Options, in order
of preference:
  1. Retry off-peak (late evening IST, or a weekend) - capacity frees up and is taken quickly.
  2. Ask for less: --ocpus 1 --memory 6 is inside the 2/12 ceiling and finds a slot sooner.
  3. Fall back to the two Always Free AMD micros (2x VM.Standard.E2.1.Micro, 1 GB each). They are
     small but they are not contended, and they are not subject to the ARM idle-reclaim rule.
  4. Upgrade the tenancy to PAYG. Stays inside the free limits but gets priority capacity.
See docs/oracle-deploy.md for the micro and PAYG paths.
EOF
  exit 1
fi

private_ip_id() {
  local vnic_id
  vnic_id="$(oci compute instance list-vnics --instance-id "$instance_id" \
    --query 'data[0]."id"' --raw-output)" || return 1
  oci network private-ip list --vnic-id "$vnic_id" \
    --query 'data[0]."id"' --raw-output
}

if ((RESERVE_IP)); then
  echo "creating a reserved public IP"
  pip_id="$(private_ip_id)" || fail "could not find the instance's primary private IP"
  [[ -n "$pip_id" ]] || fail "could not find the instance's primary private IP"

  ip_id="$(oci network public-ip create \
    --compartment-id "$COMPARTMENT_OCID" \
    --lifetime RESERVED \
    --private-ip-id "$pip_id" \
    --display-name "${DISPLAY_NAME}-ip" \
    --query 'data.id' --raw-output)" || fail "could not create the reserved public IP"

  ip_address="$(oci network public-ip get --public-ip-id "$ip_id" \
    --query 'data."ip-address"' --raw-output)"

  echo "reserved public IP: ${ip_address} (${ip_id})"
  cat <<EOF

Register ${ip_address} as the SmartAPI primary IP for the Angel One app BEFORE the first login,
or every request from this host will be refused. The API key and TOTP must belong to the same
Angel One account as the client code.

Then:
  ssh opc@${ip_address}
  follow docs/oracle-deploy.md from section 2 (Install Docker)

Note: a reserved IP survives terminating and rebuilding the instance. An ephemeral one does not,
and an existing ephemeral address cannot be converted - so do this now, not after go-live.
EOF
else
  cat <<EOF

The instance has an EPHEMERAL public IP, which is released if the instance is terminated. For a
host that SmartAPI will call, pass --reserve-ip next time or attach a reserved IP before
registering anything with Angel One.

Then:
  ssh opc@<its public ip>
  follow docs/oracle-deploy.md from section 2 (Install Docker)
EOF
fi
