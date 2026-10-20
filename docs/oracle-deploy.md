# Deploying to Oracle Cloud Always Free

Target: one Oracle Cloud **Always Free** ARM VM running Postgres + the harness worker +
the Next.js dashboard via `docker-compose.yml`. Zero recurring cost, truly always-on.

## 1. Create the VM

> **Read this before touching the shape menu.** Always Free Ampere A1 is **2 OCPU / 12 GB**,
> effective **15 June 2026**. From **18 August 2026** Oracle **terminates** Always Free instances
> that sit above that ceiling. Nearly every guide on the internet - and every earlier revision of
> this file - says 4 OCPU / 24 GB. Following one of those costs you the instance weeks later, with
> no warning and no appeal. `scripts/oracle-a1-retry.sh` refuses to launch above 2 / 12 for exactly
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

**"Out of capacity for shape VM.Standard.A1.Flex"** is the normal answer on a busy free tier, not a
mistake you made. Capacity is granted per availability domain and it comes and goes through the day.
`scripts/oracle-a1-retry.sh` asks again across every AD until one says yes:

```bash
COMPARTMENT_OCID=ocid1.compartment... SUBNET_OCID=ocid1.subnet... \
  ./scripts/oracle-a1-retry.sh --dry-run          # read the plan first
COMPARTMENT_OCID=... SUBNET_OCID=... \
  ./scripts/oracle-a1-retry.sh --reserve-ip       # then run it for real
```

It is written for **Oracle Cloud Shell**, which already has an authenticated `oci` CLI, so there is
nothing to install.

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

Oracle Linux 9 (the validated image):

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

## 8. HTTPS and a domain

The session cookie is `Secure` under `NODE_ENV=production`, so serving plain HTTP means the
browser silently refuses to send the login cookie and the dashboard appears signed out. Put a
TLS-terminating reverse proxy in front.

An nginx overlay is included. Bring it up as a second compose file rather than editing the base
one, so the plain-HTTP path still works for a first look:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Generate a self-signed certificate once (a real certificate needs a domain, so for a family
dashboard on an IP this is the usual start):

```bash
mkdir -p nginx/certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout nginx/certs/tls.key -out nginx/certs/tls.crt \
  -subj "/CN=<vm-public-ip>" -addext "subjectAltName=IP:<vm-public-ip>"
chmod 600 nginx/certs/tls.key
```

Then copy `nginx/certs/` into the running container, or mount it (the overlay mounts
`./nginx/certs` read-only). Open `https://<vm-public-ip>` and accept the warning; a
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
  one; the host firewall is the inner one. On Oracle Linux 9 that is `firewall-cmd`, and on
  Ubuntu it is `ufw` - neither is installed by default on a fresh VM, so in practice the security
  list is what protects you. Do not enable a host firewall you have not configured, or you will
  lock yourself out over SSH.
- **Do not publish the database**: `docker compose ps` should show `127.0.0.1:5432->5432/tcp`
  for `db` and `0.0.0.0:3000->3000/tcp` for `web`. If `5432` appears without the `127.0.0.1`
  prefix, something has overridden the port binding and the database is reachable from the
  internet.
- **Secrets**: `.env` is gitignored and excluded from the Docker build context by
  `.dockerignore`. Check both before pushing (`git check-ignore -v .env`), because a leaked
  Angel One key is a live broker credential.
