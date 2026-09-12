# Loop Lab

An HVAC PID tuning trainer. Thirteen control loops across air temperature, water
temperature, pressure and airflow, each simulated with realistic dynamics — two
thermal lags in series, transport dead time, a slew-rate-limited actuator, sensor
noise and a controller input filter.

Two modes:

- **Training** — pick a loop with a known fault, read the trend, tune it. An
  analyzer explains what the evidence shows and why.
- **Random service call** — random equipment, scrambled dynamics, one hidden
  fault, nothing labelled. Tune it, verify two recoveries, sign off, then find
  out what was actually wrong.

Two controller flavours: **Generic** (proportional band, integral time,
derivative time) and **Siemens** (gain and Tn only, with an error coefficient
for loops whose required gain falls off the end of the dial).

---

## Quick start, locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

```bash
npm run build        # production build into dist/
npm test             # headless render + interaction test
npm run preview      # serve the built output
```

## Quick start, Docker

```bash
docker compose up -d --build
```

Then open <http://localhost:8080>.

---

## Deploying to your server

The recommended setup builds the image in GitHub Actions and has the server pull
it. The server never needs Node, npm, or the source — just Docker. Updating is
one command and takes seconds instead of minutes.

### One-time: push to GitHub

```bash
git init
git add .
git commit -m "Loop Lab"
git branch -M main
git remote add origin git@github.com:YOURNAME/loop-lab.git
git push -u origin main
```

The workflow in `.github/workflows/build.yml` runs on every push to `main`. It
installs dependencies, builds, runs the smoke test, and — only if all of that
passes — builds the Docker image and pushes it to the GitHub Container Registry
at `ghcr.io/YOURNAME/loop-lab`. A failing test blocks the image from publishing,
so a broken build can't reach your server.

Images are tagged `latest`, `sha-<short commit>`, and for `v*` git tags, the
semver version.

### One-time: make the image pullable

By default a new GHCR package is private. Either:

- **Make it public** — on GitHub go to your profile → Packages → `loop-lab` →
  Package settings → Change visibility → Public. The server then pulls with no
  credentials. Fine for this, since the image contains nothing secret.
- **Or keep it private** and log in on the server once with a personal access
  token that has `read:packages`:

  ```bash
  echo "YOUR_TOKEN" | docker login ghcr.io -u YOURNAME --password-stdin
  ```

### One-time: set up the server

```bash
mkdir -p ~/loop-lab && cd ~/loop-lab

# Only three files are needed on the server
curl -O https://raw.githubusercontent.com/YOURNAME/loop-lab/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/YOURNAME/loop-lab/main/deploy.sh
curl -o .env https://raw.githubusercontent.com/YOURNAME/loop-lab/main/.env.example
chmod +x deploy.sh

nano .env      # set IMAGE=ghcr.io/yourname/loop-lab and pick a port
./deploy.sh
```

Cloning the whole repo on the server works too, and makes updates
`git pull && ./deploy.sh`. Either is fine — the three files are all that gets used.

### The update loop

On your machine:

```bash
git add -A && git commit -m "what changed" && git push
```

Wait for the green check in the repo's Actions tab (about a minute), then on the
server:

```bash
./deploy.sh
```

That pulls the new image, restarts the container, prunes the old image, and
waits for the healthcheck before reporting success. If it doesn't come up
healthy within 60 seconds it prints the logs and exits non-zero.

### Rolling back

Every commit publishes an immutable `sha-` tag, so rollback is exact:

```bash
# find the tag you want under the repo's Packages page, then
TAG=sha-1a2b3c4 ./deploy.sh
```

To make it stick, set `TAG=` in `.env`. Setting it back to `latest` resumes
following `main`.

---

## Optional extras

### Automatic updates

If you'd rather not SSH in at all, add Watchtower to the compose file and it
will poll the registry and restart the container when a new image appears:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 300 --cleanup loop-lab
```

Convenient, but it means whatever lands on `main` goes live unattended. Worth it
for a trainer, less so for anything people depend on.

### HTTPS

Keep `HOST_PORT=8080` and put a reverse proxy in front. Caddy is the least
effort — it gets certificates automatically:

```
looplab.yourdomain.com {
    reverse_proxy localhost:8080
}
```

If the server is on an isolated OT network with no internet, plain HTTP on
port 80 is usually what you want instead: set `HOST_PORT=80` in `.env`.

### Deploying straight from Actions

You can have the workflow SSH in and run `deploy.sh` itself. It removes the
manual step but means storing an SSH key in repository secrets that can reach
your server. Given how little `./deploy.sh` costs, the manual version is
usually the better trade.

---

## Layout

```
src/PidTrainer.jsx      the whole trainer — simulation, analyzer, UI
src/main.jsx            mount point, bundles the fonts
test/smoke.mjs          headless render + interaction test
Dockerfile              node build stage, nginx serve stage
nginx.conf              SPA fallback, cache headers, /healthz
docker-compose.yml      local: builds from source
docker-compose.prod.yml server: pulls the published image
deploy.sh               pull, restart, verify health
.env.example            copy to .env on the server
```

### Notes

Fonts are bundled via `@fontsource` rather than fetched from Google. Building
automation networks are frequently isolated, and a webfont that silently fails
to load makes the whole interface look broken.

The container runs read-only with tmpfs for nginx's scratch paths and
`no-new-privileges`. It serves static files only — there is no backend, no
database, and nothing written at runtime.

`npm test` renders the app in jsdom and clicks through all thirteen scenarios,
both controller flavours, the analyzer, a blind service call and the help
sheets. It is the CI gate before an image is published.

---

## Still to come

Sign-in and a shared leaderboard for competition mode. That needs an API and a
database — `docker-compose.prod.yml` has a commented sketch of the services, and
`nginx.conf` already does SPA fallback so client-side routes will work.

Worth deciding early: for a fair leaderboard the timed mode should use a seeded
random generator so everyone races the identical process and fault, and scores
should be verified server-side. As it stands the simulation runs entirely in the
browser, where a submitted time can't be trusted.
