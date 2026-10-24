CLAUDE CODE WEB UI 1.0.0
=======================
The same interface and deployment pattern as Codex Web, backed by Claude Code.

Included functions
------------------
* Streaming chat, activity/tool output, stop, new conversation and saved history.
* Image paste, file picker, previews, removal and attachment-only messages.
* /model and the Model button: models and effort levels discovered from Claude.
* Full Access On/Off above Chat/Terminal: saved across restarts and new chats.
* Permission requests with Allow once/Deny and answers to Claude's questions.
* Native Claude terminal: all slash commands supported by your installed CLI,
  keyboard input, resize, replay after refresh, and end session.
* Authenticated workspace file browser/downloads at /claude/files/.
* Basic authentication, origin checks, private saved files and HTTPS options.
* Portable container, host bind mounts, Apache/Nginx reuse, automatic httpd setup.
* Standalone Linux executable accepting --claude and --folder, with HTTP/HTTPS.

The native terminal owns Claude's full command menu. Chat shortcuts are
/model, /help, /status, /stop, /new and /terminal. Type / inside the terminal
for native commands. Terminal starts a separate conversation; /resume can
open a saved chat. End the terminal before using Chat. Refresh reconnects;
restarting the server ends the terminal. One shared conversation/task per UI.

Portable bundle: first use
--------------------------
Copy the ENTIRE claude-web-portable directory to a Linux x86-64 Docker host:

  cd /path/to/claude-web-portable
  ./claude-web.sh login
  ./claude-web.sh start
  cat web.env

Complete Claude's browser login flow. Open http://localhost:8081/claude/ and
use the username/password from web.env. Claude authentication and the web
password are separate. The image includes Claude Code 2.1.310, Node.js 22,
all runtime dependencies and this UI. No build or npm install is required.
Model calls and login still need network access; model weights are not bundled.

For another computer, change BIND_ADDRESS=0.0.0.0 in web.env, then:

  ./claude-web.sh stop
  ./claude-web.sh start

Open http://HOST_IP:8081/claude/. WEB_PORT selects a different free host port.
Use an existing HTTPS server or the standalone TLS options for encrypted access.

Existing Apache httpd on port 80
--------------------------------
The setup script detects the running httpd service, its configuration and
installed proxy modules. It backs up configuration, adds /claude/ and validates
before reload. It leaves /codex/ and the existing website in place.

  sudo python3 proxy/setup-httpd.py --bundle "$PWD" --dry-run
  sudo python3 proxy/setup-httpd.py --bundle "$PWD"

First-use Claude login is still required: ./claude-web.sh login.
If more than one virtual host is active, use --site or --config to select it.
The backend uses 127.0.0.1:18766; Apache keeps port 80 and existing TLS config.
Manual Apache/Nginx setup and recovery instructions are in proxy/README.txt.

  ./claude-web.sh proxy-setup

This manual command only generates include files and configures the private
port. Include proxy/apache.conf or proxy/nginx.conf in your existing server,
then validate/reload it and start the container. /claude/files/ is included.

Storage, moving and upgrading
-----------------------------
The launcher bind-mounts these HOST directories, not container-only storage:

  data/             -> /data      Login, Claude settings/sessions, web history,
                                  uploads, saved model and access mode
  workspace/        -> /workspace Projects and files
  web.env                        Web credentials, binding, optional API key

The container runs as UID/GID 1000. Host project directories must permit that
user to read/write. To use another existing directory, use a bind mount in
compose.yaml, or the standalone --folder option below.

Stop before copying the whole folder or making a consistent backup:

  ./claude-web.sh stop
  # Copy the directory, retaining hidden files, ownership and permissions.
  ./claude-web.sh start

Keep web.env, data/ and workspace/ when extracting future upgrades over the
same folder. The launcher rejects containers owned by a different folder.
Do not stop a container with missing host data directories before recovering
its mounted data; see proxy/README.txt. Stop does not delete persistent data.

Full Access
-----------
Off uses Claude's explicit 'default' permission mode and displays approval
requests. Existing Claude allow/deny rules and hooks still apply.
On uses 'bypassPermissions' and allowDangerouslySkipPermissions=true. OS,
read-only mounts and managed Claude policy still apply. This is Claude's
native permission system, not Codex's workspace-write sandbox.

Switch while idle; it applies to the next chat turn and new terminal sessions.
The saved choice overrides CLAUDE_WEB_ACCESS_MODE (workspace/full-access),
which is only the initial default. A fresh installation starts Off.
Native terminal permission changes apply independently to that terminal.
Claude refuses permission-bypass mode as root. The container already runs
as non-root; run the standalone UI as a normal user to use Full Access.

Standalone Linux executable
---------------------------
The separate claude-ui-1.0.0-linux-x64 executable bundles Node and the UI's
runtime dependencies. Supply your own installed, authenticated Claude binary:

  chmod +x claude-ui-1.0.0-linux-x64
  ./claude-ui-1.0.0-linux-x64 --claude /absolute/path/to/claude \
    --folder /absolute/path/to/project --host 0.0.0.0 --port 8081

It prints the location of the generated web password. Run --help for all
options, including --data-dir, --username and --password-file. It uses the
service user's existing Claude login, or CLAUDE_CONFIG_DIR/ANTHROPIC_API_KEY.
HTTPS uses the same port:

  ./claude-ui-1.0.0-linux-x64 --claude /absolute/path/to/claude \
    --folder /absolute/path/to/project --port 8443 \
    --tls-cert /path/to/fullchain.pem --tls-key /path/to/private-key.pem

Linux x86-64 with glibc 2.28+ and standard C++ runtime libraries is required.
No system Node/npm/Python is needed. It unpacks its embedded runtime into a
private temporary directory and removes it at exit; TMPDIR must allow execution.
Hidden files, state, credentials, TLS keys and escaping symlinks are excluded
from the file browser. Files download as attachments rather than executing HTML.

Source / Compose
----------------
Run from source using Node.js 22:

  npm ci
  node server.js --claude /path/to/claude --folder /path/to/project

Or build a container from source with Docker Compose v2:

  cp .env.example .env
  # Set a strong CLAUDE_WEB_PASSWORD in .env.
  docker compose build
  mkdir -p data/claude data/home workspace
  sudo chown 1000:1000 data data/claude data/home workspace
  docker compose run --rm claude-web claude auth login
  docker compose up -d

The portable launcher performs directory initialization automatically.
For API-key authentication, add ANTHROPIC_API_KEY to portable web.env; the
launcher passes that file into login/start containers. Compose users can
explicitly pass their provider's environment settings in compose.yaml.
No host login, API key, web password, conversation or project is in the release.

Checks
------
  npm test
  python3 tests/container.py
  python3 tests/browser.py       # requires Python Playwright + Chromium
  python3 tests/binary.py        # requires built binary and openssl
  python3 tests/setup-httpd.py
  python3 tests/recover-running-bundle.py

Build standalone binary using Node 22 on Linux x64: node build-binary.js.
The source includes package-lock.json and dependency notices. Anthropic's
Claude Code is distributed as the installed CLI in the container, not claimed
as open-source application code. Vendored xterm's license is XTERM-LICENSE.

Validated: real Claude login status, model discovery, chat and session resume;
mocked model calls for permission/error/upload regressions; actual PTY and
container persistence; browser UI/mobile; standalone HTTPS and file isolation.
The source host's old Docker seccomp policy blocked GNU make during node-pty
compilation. Its one-time dependency build used an unconfined build container;
the final application runs with Docker's normal runtime security settings.

Official integration references:
https://code.claude.com/docs/en/agent-sdk/overview
https://code.claude.com/docs/en/agent-sdk/user-input
https://code.claude.com/docs/en/agent-sdk/permissions
https://code.claude.com/docs/en/cli-reference
