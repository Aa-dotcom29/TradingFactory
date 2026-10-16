# Deploying to Oracle Cloud Always Free

Target: one Oracle Cloud **Always Free** ARM VM running Postgres + the harness worker +
the Next.js dashboard via `docker-compose.yml`. Zero recurring cost, truly always-on.

## 1. Create the VM

1. Oracle Cloud Console -> Compute -> Instances -> **Create instance**.
2. Image: **Ubuntu 22.04** (or Oracle Linux 9).
3. Shape: **VM.Standard.A1.Flex** (ARM Ampere). Always Free allows up to 4 OCPUs and
   24 GB RAM - 2 OCPU / 12 GB is plenty. This is the Always Free ARM shape; do not pick
   a paid x86 shape.
4. Add your SSH public key.
5. Ensure the subnet has a public IP and the security list allows inbound **22** (SSH),
   **80** and **443** (dashboard) - or a custom port if you prefer.

> Postgres is not exposed to the internet in the compose file; keep port `5432` closed
> in the security list. The worker and dashboard talk to it over the Docker network.

## 2. Install Docker

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

## 8. Optional: HTTPS and a domain

Put Caddy in front for automatic TLS, or add a Caddy service to the compose file:

```
dashboard.example.com {
    reverse_proxy web:3000
}
```

With TLS in place, the session cookie is already `Secure` in production.

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
- **Firewall**: remember both the Oracle security list *and* `ufw` if enabled.
