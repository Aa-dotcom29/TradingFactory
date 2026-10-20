#!/usr/bin/env bash
#
# Compatibility shim. The launcher grew into scripts/oracle-deploy.sh, which now also opens the
# security-list ports, waits for SSH and bootstraps the machine. This path is kept because the
# deployment notes used it: it is exactly `oracle-deploy.sh provision`.
#
# --reserve-ip is accepted and ignored: a reserved public IP is no longer optional, because an
# ephemeral one cannot be converted and SmartAPI requires the primary IP to be stable.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
args=()
for arg in "$@"; do
  case "$arg" in
    --reserve-ip) ;;
    *) args+=("$arg") ;;
  esac
done

exec "${here}/oracle-deploy.sh" provision ${args[@]+"${args[@]}"}
