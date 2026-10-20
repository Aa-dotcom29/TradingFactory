# Deploying to Oracle Cloud Always Free

Target: one Oracle Cloud **Always Free** ARM VM running Postgres + the harness worker +
the Next.js dashboard via `docker-compose.yml`. Zero recurring cost, truly always-on.

## 0. Create the account (one-time)

The account is free and has no expiry; the card is used only for identity verification.

- One Always Free account per person. Do not create a second account to get around a declined
  card; Oracle treats that as abuse.
- Accepted: Visa or Mastercard **credit** cards, or debit cards that work like credit
  (international/online transactions enabled). Rejected: RuPay, prepaid, virtual, single-use,
  and PIN-only debit cards. RuPay fails even with international transactions enabled.
- Oracle places a temporary authorisation hold (about USD 1 / INR 100). Your bank reverses it in
  3-5 days. It is not a charge unless you upgrade to Pay As You Go.
- Enter your real name and address exactly as they appear on the card. A mismatch is a common
  decline reason.
- Choose **India South (Hyderabad)** or **India West (Mumbai)** as the home region. It cannot be
  changed after signup. Hyderabad is closer for most of India; A1 capacity is scarcer there,
  which the launch script handles by rotating availability domains.
- If the card is declined: wait a day, then try a different Visa/Mastercard and a different
  browser or network. Repeated attempts increase Oracle's fraud score. If it still fails, use the
  signup-issue form instead of retrying.
- A family member's Visa/Mastercard can be used with their consent. Oracle requires accurate
  billing details, and the hold is reversed.
- Wait for the "Your account is ready" email before opening Cloud Shell. Provisioning can take a
  few minutes to a few hours.

After signup, the one-command path below is all you need.

## Quick start: one command

`scripts/oracle-deploy.sh` runs the whole provisioning path from **Oracle Cloud Shell**, which
already has an authenticated `oci` CLI and `jq`. It exists because each manual step below has a
way to fail quietly: an ephemeral IP that cannot be converted, a security list nobody opened, a
`Secure` cookie served over plain HTTP that looks like a broken login.

```bash
# inside Cloud Shell
git clone --branch slice-0-harness-backbone \
  https://github.com/Aa-dotcom29/TradingFactory.git
cd TradingFactory
tmux new -s tf                                # the launch retry can run for hours
./scripts/oracle-deploy.sh --dry-run          # resolve tenancy, image, ADs; change nothing
./scripts/oracle-deploy.sh --owner-email you@example.com
```

It will:

1. resolve the compartment (the tenancy root by default), the first public subnet and the newest
   Ubuntu image for the shape;
2. launch `VM.Standard.A1.Flex` at **2 OCPU / 12 GB**, rotating through availability domains when
   capacity is refused and dropping to 1/6 after three empty rounds - never above the Always Free
   ceiling, which is checked before any network call;
3. create and attach a **reserved** public IP (a re-run reuses the instance and its IP);
4. open 22/80/443 on the subnet's security lists, leaving existing rules alone;
5. SSH in and run `scripts/oracle-host-bootstrap.sh`: Docker, the repo, `.env` (mode 600, generated
   database password), a self-signed certificate for the IP, the stack, and the first household
   login;
6. write `oracle-inventory.env` (gitignored) with the instance OCID, address, key and login user.

It prompts for the Angel One and Telegram credentials. To avoid typing them, upload a copy of your
local `.env` with Cloud Shell's upload button and pass `--env-file <path>`: CRLF is normalised to
LF, `DATABASE_URL` is cleared and `AUTH_DISABLED` is forced to `false` on the host.

What it deliberately leaves to you:

- **Register the reserved IP as the SmartAPI primary IP** in the Angel One console. That is an
  account action, and it only works after the IP exists - which is why the script reserves it
  first. Angel's current policy (September 2025) enforces the static IP only for Orders and GTT;
  login and data APIs are not origin-gated. Register it anyway: it keeps the key aligned with the
  host and is required before any order API is ever enabled.
- **Flip delivery to live**, one horizon at a time: `PUBLISH_MODE_POSITIONAL=live`, then `_SWING`,
  then `_INTRADAY` last. The deployed stack starts in shadow.

Afterwards:

```bash
./scripts/oracle-deploy.sh status     # instance state + whether the dashboard answers
./scripts/oracle-deploy.sh ssh        # shell on the VM
./scripts/oracle-deploy.sh deploy     # pull, rebuild, restart (safe to re-run)
```

The scripts are tested offline, with no tenancy and no Docker:

```bash
bash scripts/oracle-deploy.test.sh    # the rail, port parsing, dotenv, inventory, secrets
```

Two notes on the defaults:

- **Ubuntu, not Oracle Linux.** OL9 runs SELinux in enforcing mode, which denies the container bind
  mounts (schema, nginx config, certificates) unless every mount is relabelled. Ubuntu avoids a
  first deployment failing for a reason that has nothing to do with this application.
  `--os oraclelinux` is supported and warns when it sees SELinux enforcing.
- **`--ballast-gb N`** optionally allocates and holds N GB of RAM so an idle week stays above
  Oracle's 20% memory threshold. It is an opt-in workaround for the reclamation policy described
  in section 1, not a fix.

Everything below is the manual path, and the reasoning behind each step.

## 1. Create the VM

> **Read this before touching the shape menu.** Always Free Ampere A1 is **2 OCPU / 12 GB**,
> effective **15 June 2026**. From **18 August 2026** Oracle **terminates** Always Free instances
> that sit above that ceiling. Nearly every guide on the internet - and every earlier revision of
> this file - says 4 OCPU / 24 GB. Following one of those costs you the instance weeks later, with
> no warning and no appeal. `scripts/oracle-deploy.sh` refuses to launch above 2 / 12 for exactly
> this reason; do not work around it.

1. Oracle Cloud Console -> Compute -> Instances -> **Create instance**.
2. Image: **Oracle Linux 9** aarch64 (validated) or **Ubuntu 22.04** aarch64.
3. Shape: **VM.Standard.A1.Flex** (ARM Ampere), **2 OCPU / 12 GB**. That is the whole Always Free
   A1 allowance, and it is far more than this stack needs - 1 OCPU / 6 GB also fits and is easier
   to be granted. Do not pick a paid x8x shape.
4. Add your SSH public key.
5. **Attach a reserved public IP before you register anything with Angel One** - see step 6.
6. Ensure the subnet has a public IP. In the security list allow inbound **22** (SSH) and
   **3000** (dashboard). Add **80**/**443** when you bring up the TLS overlay in section 8.
   `oracle-deploy.sh` does all of this for you.

**"Out of capacity for shape VM.Standard.A1.Flex"** is the normal answer on a busy free tier, not a
mistake you made. Capacity is granted per availability domain and it comes and goes through the day.
`scripts/oracle-deploy.sh` asks again across every AD until one says yes:

```bash
./scripts/oracle-deploy.sh provision --dry-run    # read the plan first
./scripts/oracle-deploy.sh provision              # create the VM + reserved IP, stop there
```

It resolves the compartment and subnet itself; pass `--compartment` / `--subnet` (name or OCID)
when the tenancy has more than one VCN. `scripts/oracle-a1-retry.sh` is kept as a shim for
`oracle-deploy.sh provision` so older notes still work.

> **Ephemeral versus reserved.** An ephemeral IP survives reboots and stop/starts; it is released
> only when the instance is **terminated** or its VNIC is deleted. An existing ephemeral address
> **cannot** be converted to reserved. OCI charges nothing for public IPv4 either way, so there is
> no reason to accept an ephemeral one: create the instance, attach a **reserved** public IP, and
> only then register that address as the Angel One SmartAPI **primary IP**. Do it in that order, or
> you will be re-registering the IP with Angel every time the instance is rebuilt.

> **Idle reclamation.** Oracle reclaims Always Free compute that goes unused for seven days - CPU
> p95 below 20%, network below 20% and, on A1 only, memory below 20%, all together. A light
> ten-second poller is exactly the workload that trips the memory criterion. If the instance
> disappears after a quiet week, this is why. Upgrading the tenancy to PAYG keeps it inside the
> Always Free limits, costs nothing, and is reported to bypass idle reclamation.

> **If A1 never grants.** The two AMD micros (`VM.Standard.E2.1.Micro`, 1/8 OCPU / 1 GB each) are
> not contended and are not subject to idle reclamation. They are small - run Postgres and the
> harness on one and the dashboard on the other - but they are always available.

> Postgres is not exposed at all: the compose file binds `5432` to `127.0.0.1` only, and the
> worker and dashboard reach it over the Docker network. Leave `5432` closed in the security
> list - there is no scenario where it should be public.

## 2. Install Docker

`scripts/oracle-host-bootstrap.sh` does this on the automated path, including the compose plugin.
By hand:

> **Oracle Linux 9 note.** SELinux is enforcing on OL9. Docker bind mounts (the schema file, the
> nginx config, `nginx/certs`) are denied unless they are relabelled. Either use Ubuntu, or add
> `:z` to each bind mount in the compose files before starting the stack.

Oracle Linux 9:

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in
```

Ubuntu 22.04 instead:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER"   # log out and back in
```

## 3. Get the code

```bash
git clone <your-repo-url> tradingfactory
cd tradingfactory
git checkout slice-0-harness-backbone   # or main once merged
```

## 4. Configure

```bash
cp .env.example .env
nano .env
```

Set at least:

```
POSTGRES_PASSWORD=<a long random password>
ANGEL_CLIENT_ID=<angel client id>
ANGEL_API_KEY=<angel api key>
ANGEL_PASSWORD=<angel pin>
ANGEL_TOTP_SECRET=<base32 totp secret>
```

Leave `DATABASE_URL` empty in `.env`: the compose file builds it for the containers.

## 5. Start the stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f worker
```

On first boot of an empty Postgres volume, `harness/db/schema.sql` is applied
automatically (it is mounted into `docker-entrypoint-initdb.d`).

The deployed `.env` must include a real `POSTGRES_PASSWORD`. The compose default
(`tf_local_password`) is published in this repository and must not survive contact with a
public host; the bootstrap script generates one when it creates the file.

## 6. Create the first login

```bash
docker compose exec web node -e "console.log('web is up')"   # sanity check
docker compose run --rm web node scripts/create-user.js --email you@example.com
```

The command prints a generated password (or pass `--password`). Store it somewhere safe;
it is not recoverable from the database.

Then open `http://<vm-public-ip>:3000` and sign in.

## 7. Keep it updated

```bash
git pull
docker compose up -d --build
```

On a host deployed by the script, `./scripts/oracle-deploy.sh deploy` from Cloud Shell does the
same thing (and re-uses the instance and IP). Running the bootstrap directly on the VM -
`bash ~/tradingfactory/scripts/oracle-host-bootstrap.sh --public-host <ip>` - also pulls, rebuilds
and restarts, keeping the existing `.env`.

## 8. HTTPS and a domain

The session cookie is `Secure` under `NODE_ENV=production`, so serving plain HTTP means the
browser silently refuses to send the login cookie and the dashboard appears signed out. Put a
TLS-terminating reverse proxy in front.

An nginx overlay is included. Bring it up as a second compose file rather than editing the base
one, so the plain-HTTP path still works for a first look:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

The bootstrap script starts with this overlay by default (`--no-tls` opts out) and generates the
certificate below for the reserved IP. By hand:

```bash
mkdir -p nginx/certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout nginx/certs/tls.key -out nginx/certs/tls.crt \
  -subj "/CN=<vm-public-ip>" -addext "subjectAltName=IP:<vm-public-ip>"
chmod 600 nginx/certs/tls.key
```

Then mount `nginx/certs` into the container. The overlay already does this read-only, so starting
that compose file is all that is needed. Open `https://<vm-public-ip>` and accept the warning; a
Let's Encrypt certificate with a domain removes it.

With TLS in place, the session cookie is already `Secure` in production, so nothing else in the
app changes.

## Notes and gotchas

- **ARM images**: `node:22-alpine`, `postgres:16-alpine` and the Next.js standalone
  build all publish arm64 variants, so the compose build works on the Ampere shape.
- **Schema changes**: `docker-entrypoint-initdb.d` only runs on an *empty* volume. After
  pulling schema changes to an existing database, re-apply with
  `npm run harness:schema` (from a machine with `DATABASE_URL` set) or
  `docker compose run --rm worker node harness/scripts/apply-schema.js`. The schema is
  idempotent.
- **Time zone**: the harness reasons in IST internally; the VM can stay UTC.
- **Backups**: `docker compose exec db pg_dump -U tf tradingfactory > backup.sql`.
- **Firewall**: there are two layers and both matter. The Oracle **security list** is the outer
  one; the host firewall is the inner one. `oracle-deploy.sh` merges 22/80/443 (or 22/3000 with
  `--no-tls`) into the subnet's security lists without removing existing rules; `--no-open-ports`
  leaves them untouched. On Oracle Linux 9 the inner one is `firewall-cmd`, and on Ubuntu it is
  `ufw` - neither is installed by default on a fresh VM, so in practice the security list is what
  protects you. Do not enable a host firewall you have not configured, or you will lock yourself
  out over SSH.
- **Do not publish the database**: `docker compose ps` should show `127.0.0.1:5432->5432/tcp`
  for `db` and `0.0.0.0:3000->3000/tcp` for `web`. If `5432` appears without the `127.0.0.1`
  prefix, something has overridden the port binding and the database is reachable from the
  internet.
- **Secrets**: `.env` is gitignored and excluded from the Docker build context by
  `.dockerignore`. Check both before pushing (`git check-ignore -v .env`), because a leaked
  Angel One key is a live broker credential.
