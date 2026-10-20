#!/usr/bin/env bash
#
# Runs ON the Oracle VM. Installs Docker, checks out the repo, writes .env, puts a TLS
# terminator in front of the dashboard, starts the stack and creates the first login.
#
# This file is called by scripts/oracle-deploy.sh over SSH and is also safe to run by hand:
#
#   bash scripts/oracle-host-bootstrap.sh --public-host 203.0.113.10 --owner-email me@example.com
#
# It is idempotent. Re-running it pulls the branch, keeps the existing .env unless a new one is
# supplied, rebuilds changed images and restarts the stack. It never prints secret values.
#
# WHY UBUNTU IS THE DEFAULT FOR THE AUTOMATED PATH
#   Oracle Linux 9 ships SELinux enforcing, and Docker bind mounts (the schema, the nginx config,
#   the certificate) are denied unless every mount is relabelled. Ubuntu carries no SELinux, so the
#   first deployment does not fail for a reason that has nothing to do with this application.
#
# USAGE
#   bash scripts/oracle-host-bootstrap.sh [options]
#
# OPTIONS
#   --repo-url URL       default https://github.com/Aa-dotcom29/TradingFactory.git
#   --branch NAME        default slice-0-harness-backbone
#   --app-dir DIR        default $HOME/tradingfactory
#   --env-file FILE      install this as .env (mode 600). Without it an existing .env is kept, or
#                        one is created from .env.example with a generated Postgres password.
#   --public-host VALUE  IP or hostname the dashboard is reached on; used for the TLS certificate
#                        and for the final report. Required with TLS.
#   --tls / --no-tls     default on. The session cookie is Secure in production, so the dashboard
#                        is only usable over HTTPS.
#   --owner-email EMAIL  create this household login if it does not exist, and print the password
#                        once. Existing logins are left alone.
#   --household NAME     default Home
#   --ballast-gb N       default 0. Allocate and hold N GB of RAM to stay above Oracle's 20%
#                        memory-idle reclamation threshold. Opt-in: it is a workaround, not a fix.
#   --force-env          overwrite an existing .env even when no --env-file is supplied
#   --skip-build         do not rebuild images (config-only change)
#   --help
#
# EXIT CODES
#   0 done, 1 a step failed, 2 bad invocation.

set -euo pipefail

REPO_URL="https://github.com/Aa-dotcom29/TradingFactory.git"
BRANCH="slice-0-harness-backbone"
APP_DIR="${HOME}/tradingfactory"
ENV_SRC=""
PUBLIC_HOST=""
TLS=1
OWNER_EMAIL=""
HOUSEHOLD="Home"
BALLAST_GB=0
FORCE_ENV=0
SKIP_BUILD=0
OWNER_RESULT=""

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'FAIL: %s\n  (try --help)\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
}

is_number() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Reads KEY from a dotenv file without executing it. Last assignment wins, matching compose.
env_get() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Sets KEY=VALUE in a dotenv file, replacing any previous assignment and leaving the rest intact.
# Values containing whitespace or a comment marker are quoted so compose reads them whole.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  case "$value" in
    *[[:space:]#]*) value="\"${value}\"" ;;
  esac
  tmp="$(mktemp "${file}.XXXXXX")"
  {
    if [[ -f "$file" ]]; then
      grep -v -E "^[[:space:]]*${key}=" "$file" || true
    fi
    printf '%s=%s\n' "$key" "$value"
  } >"$tmp"
  mv "$tmp" "$file"
}

gen_password() {
  # 24 base64 chars, no punctuation that a dotenv or a shell would mangle.
  openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-24
}

# --- arguments -------------------------------------------------------------------------------

parse_args() {
  while (($#)); do
    case "$1" in
      --repo-url) REPO_URL="${2:-}"; shift ;;
      --branch) BRANCH="${2:-}"; shift ;;
      --app-dir) APP_DIR="${2:-}"; shift ;;
      --env-file) ENV_SRC="${2:-}"; shift ;;
      --public-host) PUBLIC_HOST="${2:-}"; shift ;;
      --owner-email) OWNER_EMAIL="${2:-}"; shift ;;
      --household) HOUSEHOLD="${2:-}"; shift ;;
      --ballast-gb) BALLAST_GB="${2:-}"; shift ;;
      --tls) TLS=1 ;;
      --no-tls) TLS=0 ;;
      --force-env) FORCE_ENV=1 ;;
      --skip-build) SKIP_BUILD=1 ;;
      --help | -h) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
    shift
  done

  is_number "$BALLAST_GB" || usage_error "--ballast-gb must be a whole number, got '${BALLAST_GB}'"
  [[ -n "$REPO_URL" ]] || usage_error "--repo-url is required"
  [[ -n "$BRANCH" ]] || usage_error "--branch is required"
  [[ -n "$APP_DIR" ]] || usage_error "--app-dir is required"
  if ((TLS == 1)) && [[ -z "$PUBLIC_HOST" ]]; then
    usage_error "--public-host is required with TLS (pass --no-tls to skip the certificate)"
  fi
  if [[ -n "$ENV_SRC" && ! -f "$ENV_SRC" ]]; then
    die "env file not found: ${ENV_SRC}"
  fi
}

SUDO="sudo -n"

# --- steps -----------------------------------------------------------------------------------

require_sudo() {
  if ! $SUDO true 2>/dev/null; then
    die "passwordless sudo is required (the Oracle default users have it). Run as the image's default
  user (ubuntu/opc), not as root."
  fi
}

detect_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
  else
    OS_ID="unknown"
    OS_LIKE=""
  fi
  case "${OS_ID} ${OS_LIKE}" in
    *ubuntu* | *debian*) OS_FAMILY="apt" ;;
    *ol* | *rhel* | *fedora* | *centos*) OS_FAMILY="dnf" ;;
    *) die "unsupported distribution: ${OS_ID}. Use Ubuntu (recommended) or Oracle Linux 9." ;;
  esac
  if [[ "$OS_FAMILY" == "dnf" ]] && command -v getenforce >/dev/null 2>&1 \
    && [[ "$(getenforce 2>/dev/null || echo Disabled)" == "Enforcing" ]]; then
    warn "SELinux is enforcing. Docker bind mounts may be denied; Ubuntu avoids this entirely."
  fi
  log "distribution: ${OS_ID} (${OS_FAMILY})"
}

apt_install() {
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

dnf_install() {
  $SUDO dnf install -y -q "$@"
}

install_base() {
  # These are needed by every step, not only by Docker: git clones, curl checks the dashboard,
  # openssl writes the certificate. On a re-run the package manager is a no-op.
  if [[ "$OS_FAMILY" == "apt" ]]; then
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git openssl
  else
    dnf_install ca-certificates curl git openssl dnf-plugins-core
  fi
}

install_docker() {
  install_base
  if command -v docker >/dev/null 2>&1 && $SUDO docker compose version >/dev/null 2>&1; then
    log "docker and the compose plugin are already installed"
  elif [[ "$OS_FAMILY" == "apt" ]]; then
    log "installing docker from the distribution repositories"
    # docker-compose-v2 is the compose plugin package on Ubuntu 22.04 and later.
    if ! apt_install docker.io docker-compose-v2; then
      apt_install docker.io docker-compose-plugin
    fi
  else
    log "installing docker from the Docker CE repository"
    $SUDO dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
    dnf_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  $SUDO systemctl enable --now docker
  command -v docker >/dev/null 2>&1 || die "docker is still missing after installation"
  $SUDO docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
}

checkout_repo() {
  command -v git >/dev/null 2>&1 || die "git is missing"
  if [[ -d "${APP_DIR}/.git" ]]; then
    log "updating ${APP_DIR} to origin/${BRANCH}"
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --prune --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/${BRANCH}"
    git -C "$APP_DIR" reset -q --hard "origin/${BRANCH}"
  else
    log "cloning ${REPO_URL} (${BRANCH}) into ${APP_DIR}"
    git clone --quiet --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  fi
  [[ -f "${APP_DIR}/docker-compose.yml" ]] || die "${APP_DIR} does not look like Trading Factory"
}

compose() {
  local files=(-f docker-compose.yml)
  if ((TLS == 1)); then files+=(-f docker-compose.tls.yml); fi
  ( cd "$APP_DIR" && $SUDO docker compose "${files[@]}" "$@" )
}

write_env() {
  local env_file="${APP_DIR}/.env" created=0
  if [[ -n "$ENV_SRC" ]]; then
    if [[ -f "$env_file" ]]; then
      cp -p "$env_file" "${env_file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
      log "existing .env backed up next to it"
    fi
    install -m 600 "$ENV_SRC" "$env_file"
    # A .env prepared on Windows arrives with CRLF; Docker reads the CR as part of the value and
    # every Angel One secret silently fails to match.
    sed -i 's/\r$//' "$env_file"
    # The uploaded copy carries the same secrets; it has served its purpose.
    case "$ENV_SRC" in
      /tmp/*) rm -f "$ENV_SRC" ;;
    esac
    created=1
  elif [[ ! -f "$env_file" || $FORCE_ENV -eq 1 ]]; then
    cp "${APP_DIR}/.env.example" "$env_file"
    created=1
  fi

  if ((created == 1)); then
    # Compose defaults the database password to a value published in this repository. A host that
    # is reachable from the internet must not keep that default.
    if [[ -z "$(env_get "$env_file" POSTGRES_PASSWORD || true)" ]]; then
      env_set "$env_file" POSTGRES_PASSWORD "$(gen_password)"
    fi
  fi

  # Invariants that make the deployed stack behave: the containers build DATABASE_URL themselves,
  # the dev-only auth bypass must never be set, and delivery starts in shadow.
  env_set "$env_file" DATABASE_URL ""
  env_set "$env_file" AUTH_DISABLED "false"
  if [[ -z "$(env_get "$env_file" PUBLISH_MODE || true)" ]]; then
    env_set "$env_file" PUBLISH_MODE "shadow"
  fi
  env_set "$env_file" HARNESS_RETENTION_DAYS "90"
  chmod 600 "$env_file"

  local missing=()
  for key in ANGEL_CLIENT_ID ANGEL_API_KEY ANGEL_PASSWORD ANGEL_TOTP_SECRET; do
    [[ -n "$(env_get "$env_file" "$key" || true)" ]] || missing+=("$key")
  done
  if ((${#missing[@]})); then
    warn "these keys are empty in .env: ${missing[*]}"
    warn "the harness will fall back to delayed Yahoo quotes and publish nothing until they are set"
  fi
  if [[ -z "$(env_get "$env_file" TELEGRAM_BOT_TOKEN || true)" ]]; then
    warn "TELEGRAM_BOT_TOKEN is empty; delivery stays in shadow whatever PUBLISH_MODE says"
  fi
  log ".env is in place (mode 600, secrets not echoed)"
}

write_certs() {
  ((TLS == 1)) || return 0
  local dir="${APP_DIR}/nginx/certs"
  mkdir -p "$dir"
  if [[ -s "${dir}/tls.crt" && -s "${dir}/tls.key" ]]; then
    log "TLS certificate already present; leaving it alone"
    return 0
  fi
  local host="$PUBLIC_HOST" san
  if [[ "$host" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    san="IP:${host}"
  else
    san="DNS:${host}"
  fi
  log "generating a self-signed certificate for ${host}"
  # The subject comes from a config file rather than -subj. A hostname that is an IP makes the
  # certificate the only one a browser will accept without a domain, so it needs a real SAN, and
  # a config file also survives the argument rewriting in Git Bash when this is tested on Windows.
  local cnf
  cnf="$(mktemp "${TMPDIR:-/tmp}/tf-openssl-XXXXXX.cnf")"
  cat >"$cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = ext

[dn]
CN = ${host}

[ext]
subjectAltName = ${san}
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
  local rc=0
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "${dir}/tls.key" -out "${dir}/tls.crt" -config "$cnf" >/dev/null 2>&1 || rc=$?
  rm -f "$cnf"
  ((rc == 0)) || die "openssl could not create the certificate"
  chmod 600 "${dir}/tls.key"
}

start_stack() {
  local args=(up -d)
  if ((SKIP_BUILD == 0)); then args+=(--build); fi
  log "starting the stack (this builds the images and takes a few minutes on ARM)"
  compose "${args[@]}"
  compose ps
}

wait_for_http() {
  local url="http://127.0.0.1:3000/"
  if ((TLS == 1)); then url="https://127.0.0.1/"; fi
  local i
  for i in $(seq 1 60); do
    if curl -ksf --max-time 5 "$url" -o /dev/null 2>/dev/null; then
      log "dashboard is answering at ${url}"
      return 0
    fi
    sleep 5
  done
  warn "the dashboard did not answer within 5 minutes"
  compose logs --tail 40 web >&2 || true
  return 1
}

create_owner() {
  [[ -n "$OWNER_EMAIL" ]] || return 0
  local out
  log "ensuring the household login ${OWNER_EMAIL} exists"
  if ! out="$(compose run --rm web node scripts/create-user.js --email "$OWNER_EMAIL" --household "$HOUSEHOLD" 2>&1)"; then
    warn "could not create the owner login:"
    printf '%s\n' "$out" >&2
    return 1
  fi
  # Kept for write_report, which runs after this and would otherwise truncate it away. The
  # generated password is shown once; there is no way to read it back from the database.
  OWNER_RESULT="$out"
  printf '%s\n' "$out"
}

install_ballast() {
  ((BALLAST_GB > 0)) || return 0
  local unit="/etc/systemd/system/tf-ballast.service"
  log "installing a ${BALLAST_GB} GB memory ballast (idle-reclamation workaround)"
  $SUDO tee "$unit" >/dev/null <<EOF
[Unit]
Description=Trading Factory memory ballast (Oracle Always Free idle reclamation)
After=network.target

[Service]
Type=simple
Restart=always
ExecStart=/usr/bin/python3 -c "import time; n=${BALLAST_GB}*1024*1024*1024; b=bytearray(n); [b.__setitem__(i, 1) for i in range(0, n, 4096)]; time.sleep(10**9)"

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now tf-ballast.service
}

write_report() {
  local scheme="http" port=":3000"
  if ((TLS == 1)); then
    scheme="https"
    port=""
  fi
  local report="${APP_DIR}/deploy-report.txt"
  {
    echo "Trading Factory deployment"
    echo "  completed : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "  branch    : ${BRANCH}"
    echo "  dashboard : ${scheme}://${PUBLIC_HOST:-127.0.0.1}${port}"
    echo "  directory : ${APP_DIR}"
    echo
    echo "Next steps"
    echo "  1. Register ${PUBLIC_HOST} as the SmartAPI primary IP in the Angel One console,"
    echo "     then restart the worker: sudo docker compose restart worker"
    echo "  2. Delivery starts in shadow. Flip one horizon at a time when ready:"
    echo "     PUBLISH_MODE_SWING=live (etc) in .env, then sudo docker compose up -d"
    echo "  3. Logs: sudo docker compose logs -f worker"
    if [[ -n "${OWNER_RESULT:-}" ]]; then
      echo
      echo "First login"
      printf '%s\n' "$OWNER_RESULT" | sed 's/^/  /'
    fi
  } >"$report"
  cat "$report"
}

main() {
  parse_args "$@"
  log "Trading Factory host bootstrap"
  require_sudo
  detect_os
  install_docker
  checkout_repo
  write_env
  write_certs
  local http_ok=0
  # The dashboard is a fresh volume on first run; the schema is applied by the db container.
  start_stack || die "docker compose failed"
  wait_for_http && http_ok=1
  create_owner || true
  install_ballast
  write_report
  # A failed health check is reported after the report so the operator sees the deployment facts
  # first, but it still fails the run.
  ((http_ok == 1)) || die "the dashboard is not answering; inspect the logs above"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
