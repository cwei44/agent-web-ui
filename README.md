# AI Web: Codex + Claude Code

One Linux amd64 Docker image contains both CLIs, both web UIs, Node.js and all runtime dependencies. One container serves a chooser at `/ai/`, Codex at `/codex/`, and Claude Code at `/claude/`. Each conversation links back to the chooser. Both use the same web password and a shared host workspace; conversations, uploads, account logins and Full Access settings are stored separately.

## Downloads

Get the [portable Linux amd64 package](https://github.com/cwei44/agent-web-ui/releases/download/v1.0.1/ai-web-portable-1.0.1-linux-amd64.tar.gz) and its [SHA-256 checksum](https://github.com/cwei44/agent-web-ui/releases/download/v1.0.1/ai-web-portable-1.0.1-linux-amd64.tar.gz.sha256) from [Releases](https://github.com/cwei44/agent-web-ui/releases). The portable package includes both CLI binaries and runtime dependencies in its Docker image.

## Build and run from GitHub source

From a checkout of this repository on a Linux amd64 Docker host:

```bash
git clone https://github.com/cwei44/agent-web-ui.git
cd agent-web-ui
docker build -t codex-web:1.4.0 ./codex
docker build -t claude-web:1.0.0 ./claude
docker build -t ai-web:1.0.0 .
docker image inspect ai-web:1.0.0 --format '{{.Id}}' > IMAGE_ID
./ai-web.sh login codex
./ai-web.sh login claude
```

To serve on **port 80**, run from this same directory (requires Python 3):

```bash
sudo ./ai-web.sh setup
```

Open `http://<server-ip>/ai/`. Setup reuses an active systemd `httpd.service`; otherwise, when port 80 is free, it publishes the container's built-in web server directly. Apache installation is not required. If another server occupies port 80 (including Nginx or an `apache2.service`), setup leaves it running and directs you to the manual proxy instructions. Existing unmanaged `/codex/` or `/claude/` Apache routes require the migration steps below.

For a direct local listener instead, run `./ai-web.sh start` and open `http://localhost:8082/ai/`. Web credentials are generated in `web.env`.

The Git repository contains application source, dependency lockfiles and build recipes. Private runtime data and large prebuilt archives are excluded. Both CLIs and their dependencies are installed by the Docker builds; their upstream licenses apply independently of this UI's license. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Portable release

Copy the entire `ai-web-portable` folder, or unpack `ai-web-portable-1.0.1-linux-amd64.tar.gz` on the destination Linux x86-64 Docker host:

```bash
tar -xzf ai-web-portable-1.0.1-linux-amd64.tar.gz
cd ai-web-portable
./ai-web.sh login codex
./ai-web.sh login claude
sudo ./ai-web.sh setup
```

Open `http://<server-ip>/ai/` on port 80. Web credentials are generated in `web.env`; these are separate from your provider accounts. The first command loads the bundled image automatically if needed. No Node, npm, Codex or Claude installation is required on the host. Docker and Bash are required, plus Python 3 for automatic setup; provider login and inference need network access and your own account. Claude Code is proprietary and included under its vendor license, not as open-source CLI source.

If using `start` directly without `setup`, it defaults to a private port 8082 listener. For access from another machine in that mode, run `./ai-web.sh stop`, set `BIND_ADDRESS=0.0.0.0` in `web.env`, then run `./ai-web.sh start`. Visit `http://<server-ip>:8082/ai/`. Change `WEB_PORT` to an unused port if needed. For existing HTTPS/HTTP on ports 443/80, use the proxy setup below. The default private binding is intended for a host reverse proxy or SSH tunnel.

Commands:

```bash
sudo ./ai-web.sh setup   # automatic port-80 setup
./ai-web.sh start both    # start using the saved binding; default: both assistants
./ai-web.sh status
./ai-web.sh logs
./ai-web.sh stop          # remove container, retain all data
./ai-web.sh start claude  # only Claude; start codex selects only Codex
```

`setup` can be rerun for an existing direct port-80 container. If this bundle already runs on another port, stop it when idle before switching to direct port 80. For multiple Apache sites, use `sudo ./ai-web.sh setup --site hostname` or `--config /absolute/active/site.conf`.

Stop before changing providers, ports, credentials or other environment options. To refresh a login, run `login codex` or `login claude`, then stop/start when work is idle. Provider choice persists in `web.env`.

## Host files and access

The launcher mounts these directories directly from the bundle:

- `workspace/` → `/workspace`: working files shared by both assistants and visible on the host.
- `data/codex/` → `/data/codex`: Codex conversations, uploads, configuration and login.
- `data/claude/` → `/data/claude`: Claude conversations, uploads, configuration and login.

To use another host workspace, before first start create a symlink: `ln -s /absolute/project/path workspace`. Alternatively modify the launcher mount source or the Compose volume. The container runs as UID/GID 1000. Existing project files must be writable by that identity for editing; initialization only sets ownership of the top-level workspace and app-data directories, not every project file.

The original UI features remain: streaming chat, pasted images/file uploads, model selection, approvals, native interactive terminal and slash commands, persisted conversations, and a Full Access switch in each UI. Available models and native commands depend on the selected CLI/account. Full Access defaults off and is saved independently per provider. It grants the assistant access available to the container user, including the mounted workspace; it does not make the container user host root. Both assistants share one container and are not isolated from each other by a security boundary.

To move an initialized installation, stop it first and copy the entire folder with ownership and hidden files preserved. `data/` and `web.env` contain private account credentials. No account credentials are included in the distributed archive.

## Existing Apache httpd or Nginx

For an existing systemd `httpd.service`, run as root from the bundle:

```bash
python3 proxy/setup-httpd.py --bundle "$PWD" --dry-run
python3 proxy/setup-httpd.py --bundle "$PWD"
```

The script detects the active Apache configuration, enables installed required modules, saves backups, adds all three paths, starts the container on localhost port 18760, validates configuration and reloads httpd. Open `http://<server-ip>/ai/` on that site. Use `--site hostname` or `--config /absolute/active/site.conf` when several sites exist; select the HTTPS virtual host explicitly when needed. Existing certificates and ports are retained. An error restores Apache configuration, but does not undo container changes.

The script refuses unmanaged existing `/ai/`, `/codex/` or `/claude/` routes rather than replacing another running installation. When migrating, back up and remove the old route blocks at your chosen cutover time, then run setup. It can update its own managed combined block on subsequent runs. Do not run it on a live older installation until ready for that cutover.

For manual Apache or Nginx setup:

```bash
./ai-web.sh stop
./ai-web.sh proxy-setup
./ai-web.sh start
```

Include `proxy/apache.conf` inside the existing Apache virtual host (with proxy, proxy_http, alias and env modules enabled), or `proxy/nginx.conf` inside the existing Nginx server block. Validate and reload your web server. See `proxy/README.txt` for details. All three paths use the same private backend port; host ports 80/443 remain owned by the existing web server.

## Import data from individual bundles

Stop the old and new containers before copying their data. Copy the old Codex bundle's `data/.` into the new `data/codex/`, and the old Claude bundle's `data/.` into `data/claude/`, preserving ownership (`cp -a`). Do this into fresh destination directories to avoid overwriting new chats. Select one existing workspace or merge project files deliberately; the combined package has one workspace. Retain the new `web.env` format with `AI_WEB_*` names. Do not copy either old IMAGE_ID or image archive over the combined files.

If an old container's host data directories are missing, keep that container running until its mounted data has been recovered using the old bundle's recovery tooling. This combined launcher does not automatically adopt or stop old containers.

## Source, dependencies and rebuild

Release contents include `source/` (both complete UI sources, tests, container recipes and scripts), `vendor/` (licenses and upstream open-source Codex source), `IMAGE_ID`, `SHA256SUMS`, and the prebuilt image with both installed CLIs and all runtime dependencies. Claude CLI source is not available; its executable is included. The package targets Linux amd64; other architectures need a matching rebuild.

Pinned versions: Codex CLI 0.163.0, Claude Code 2.1.310, Claude Agent SDK 0.3.310; UI bases Codex Web 1.4.0 and Claude Web 1.0.0. Rebuild from the source directory (requires network for dependencies):

```bash
docker build -t codex-web:1.4.0 ./codex
docker build -t claude-web:1.0.0 ./claude
docker build -t ai-web:1.0.0 .
```

The prebuilt release does not require rebuilding or downloading dependencies. `docker load -i image-linux-amd64.tar.gz` can load it manually. `sha256sum -c SHA256SUMS` verifies shipped files before initialization.

For Compose, create `data/` and `workspace/` with ownership UID/GID 1000 first (`sudo mkdir -p data workspace; sudo chown 1000:1000 data workspace`), copy `.env.example` to `.env`, set a unique password and run `docker compose up -d` from source. Compose and the portable launcher are alternatives; do not run both against the same data simultaneously.

Tests: `python3 tests/container.py` validates the combined image with isolated mock model calls, real CLI version checks, uploads, authentication, terminal streaming, persistence, separate access settings and provider selection. `python3 tests/setup-httpd.py` checks Apache configuration discovery and edits without changing the host service. Provider-specific tests are under each source directory.

Release validation: combined-container integration tests, launcher lifecycle and host mounts, desktop/mobile browser navigation, 20 Apache setup unit tests, and isolated Apache/Nginx HTTP/HTTPS proxy tests passed. Chat/terminal integration tests use fixture model responses; no new paid inference was required for this packaging change.

Portable release 1.0.1 adds automatic port-80 setup. The bundled runtime image and CLI versions are unchanged. `python3 tests/setup-web.py` covers detection, port conflicts, repeat setup, credential preservation and startup failures.
