Codex Lab Web — container distribution
======================================

Includes the complete web UI, image paste/file uploads, Node.js 22 and
Codex CLI 0.163.0. No Apache or systemd is needed inside the container.
Runs as UID/GID 1000. One shared conversation and one active task per instance.
Existing host credentials, chats and uploads are NOT included in the image.

Quick start with Docker Compose v2
---------------------------------
1. Extract the source package and enter codex-web-container/.
2. Copy .env.example to .env and replace CODEX_WEB_PASSWORD with a strong,
   unique password. Use a long random alphanumeric value to avoid dotenv
   quoting/interpolation differences. Protect .env (chmod 600 .env).
3. Build and sign in:

   docker compose build
   docker compose run --rm codex-web codex login --device-auth
   docker compose up -d

4. Open http://localhost:8080/codex/ and enter the username/password from .env.

The device sign-in prints a URL and code; complete the flow in your browser.
Device authentication must be enabled for your account/workspace. If your
account uses an API key instead, run the following in a shell where the key
is already set (it is read through stdin, not stored in the image):

   printf '%s' "$OPENAI_API_KEY" | docker compose run --rm -T codex-web codex login --with-api-key

Then restart the web service if it was already running:

   docker compose restart codex-web

Authentication reference: https://learn.chatgpt.com/docs/auth
CLI reference: https://learn.chatgpt.com/docs/codex/cli
App-server protocol: https://learn.chatgpt.com/docs/app-server

Use the prebuilt image
----------------------
The supplied image archive is Linux/amd64. Transfer it to another machine:

   docker load -i ../image-linux-amd64.tar.gz

Then follow the quick start, omitting the build step. Compose uses the image
named codex-web:1.4.0. The Dockerfile also supports native Linux/arm64 builds
through the upstream Node and Codex packages; arm64 has not been tested here.
Docker Desktop runs Linux containers on macOS/Windows. Outbound HTTPS access
to OpenAI is required for login and inference; this is not an offline model.

Without Compose (also works with the older Docker CLI on the source host)
------------------------------------------------------------------------
Create .env as described above, then:

   docker build -t codex-web:1.4.0 .
   docker volume create codex-data
   docker volume create codex-workspace
   docker run --rm -it -v codex-data:/data -v codex-workspace:/workspace codex-web:1.4.0 codex login --device-auth
   docker run -d --name codex-web --restart unless-stopped --env-file .env -p 127.0.0.1:8080:8765 -v codex-data:/data -v codex-workspace:/workspace codex-web:1.4.0

If you loaded the exported image, omit docker build. For a different port,
change the published port (8080) in docker run. BIND_ADDRESS and WEB_PORT in
.env control Compose only. Stop this example with docker stop codex-web.

Persistent storage
------------------
/data/codex             Codex authentication, settings and session records
/data/conversation.json Web conversation and its Codex thread ID
/data/uploads           Uploaded files, stored with mode 600
/workspace              Files Codex works on

Compose provisions named volumes for /data and /workspace. Keep both when
recreating/upgrading the service. docker compose down preserves volumes;
docker compose down -v deletes them. Back up both volumes while stopped.
Do not run multiple replicas against the same data volume.
New conversation clears the visible web chat but retains prior Codex sessions
and uploaded files. Remove old uploads manually only when no longer needed.

To work on an existing project, replace the workspace volume entry with:

   - /absolute/path/to/your/project:/workspace

The directory must be readable/writable by UID/GID 1000. For bind-mounted
/data, create and assign ownership of that directory before starting too.
Do not mount a whole host home directory or Docker socket just to run this UI.
Tools operate inside the container. Kubernetes access needs kubectl added
in a derived image and an explicitly supplied kubeconfig/network connection.

Network and access
------------------
The app listens on container port 8765 and serves the UI under /codex/.
Compose publishes to localhost:8080 by default. Set BIND_ADDRESS=0.0.0.0
for access from other computers on a trusted network, or use a reverse proxy
with HTTPS for remote access. Basic authentication alone does not encrypt
HTTP traffic. Set the proxy's request limit to at least 30 MiB, preserve Host,
disable response buffering for /codex/api/events, and allow long SSE requests.

Public GET /healthz is a liveness check and contains no account information.
A healthy container may still need Codex login; the UI explains that state.
All /codex/ routes require the configured web username and password.
Environment settings: CODEX_WEB_USERNAME (default admin), CODEX_WEB_PASSWORD
(required), HOST (default 0.0.0.0), PORT (8765), DATA_DIR (/data),
WORKSPACE_DIR (/workspace), CODEX_HOME (/data/codex), CODEX_BIN (codex).
Keep the data/workspace paths stable across container replacements.

Sandbox compatibility
---------------------
By default, Codex uses approvalPolicy=on-request and sandbox=workspace-write.
Its nested Linux sandbox requires unprivileged user namespaces allowed by
the host kernel and container runtime security policy. Some Docker setups,
including Docker 18.06 on the source host, block namespace creation. In that
case sandboxed shell commands fail; Codex may request permission to retry
outside its inner sandbox. The UI supports those approval requests. Approved
commands still run as the container user with access to its mounted volumes.
Use a runtime/host configured to support nested user namespaces if sandboxed
execution is required. This package does not enable privileged mode or disable
Docker security policies automatically.

Uploads
-------
Use Attach files or paste an image into the message box. Preview/remove files
before sending. Up to 10 files, 10 MiB each, 20 MiB total. PNG/JPEG/GIF/WebP are
sent as image inputs; other files are provided as local paths for Codex tools.
Failed submissions retain the draft and attachments for retry.

Checks and maintenance
----------------------
   docker compose ps
   docker compose logs --tail=100 codex-web
   docker compose exec codex-web codex login status
   docker compose exec codex-web node /app/healthcheck.js

Source tests (requires Node.js and npm on your test machine):
   npm ci
   npm test

Container integration tests (requires Docker and Python 3):
   python3 tests/container.py

Tests cover real Codex startup without an account, non-root execution, web
authentication, assets, health check, upload validation, image/file RPC
handoff using a mock Codex server, and persistent history/uploads across
container replacement. UI logic tests cover paste, preview/removal, retries,
limits and text-message behavior. No real model inference was run in the
container; complete your login and send a test message after deploying.

The source host does not have Compose v2 installed; raw Docker build/run were
tested. The source host's original /opt/codex-web service remains independent.

To upgrade Codex intentionally, change CODEX_VERSION in Dockerfile (or pass
--build-arg CODEX_VERSION=...) and rerun tests. Rebuild and recreate the service
while retaining its volumes. Do not bake .env, auth files or uploads into an
image; .dockerignore allows only the runtime source files into the build.

Interactive commands
--------------------
Type / to see commands, or type /model and press Enter to choose a model and
reasoning effort. The Model button opens the same picker. Available models
come from the connected Codex app-server; access depends on your account.
Click Apply while no task is running. The selection applies to subsequent
messages, persists across restarts, and is retained by New conversation.
It changes this web instance's conversation setting, not global Codex config.
Until you choose a model, the UI leaves model selection to Codex's defaults.

/model   Choose a model and reasoning effort
/help    Show supported commands
/status  Show session status and the selected model
/stop    Interrupt the active task
/new     Start a new conversation (only when idle)

These commands run in the web UI and are not sent as model prompts. Pending
attachments are retained when opening the picker or showing help/status.
For the complete native slash-command menu, open the Codex terminal tab.

Model-selection checks additionally cover paginated model discovery, supported
reasoning efforts, selected-model forwarding and restart persistence. The
browser test (tests/browser.py, requires Python Playwright and Chromium) covers
slash commands, model selection and mobile layout. BROWSER_CDP_URL can point
the test at an existing local Chromium debugging endpoint.

Complete native Codex command menu (1.3.0)
----------------------------------------
Open "Codex terminal · all / commands" and click Start Codex. Type / inside
that terminal, then use arrow keys and Enter to select a command. /terminal
in the Chat composer opens the same tab. The terminal runs your configured
Codex CLI directly; its command menu tracks that installed version, account
and enabled features. Menus such as /permissions, /skills, /mcp, /plugins,
/review, /plan, /resume and /config are handled by Codex itself.

The terminal starts its own conversation in the configured workspace and
inherits the Chat view's selected model/reasoning setting at startup. It uses
the access mode selected in the web UI initially. Native controls
such as /permissions can change settings through Codex's own interaction flow.
Use /resume inside the terminal to continue a saved conversation. The Chat
view and native terminal are exclusive: finish the current chat task before
starting the terminal, and end the terminal session to send chat messages.
The server releases the cached web thread before starting the terminal, then
refreshes its history after exit. Chat's model picker remains its own setting.

Refreshing or switching browser tabs leaves the terminal running. Output is
replayed on reconnect (up to 2 MiB, older scrollback may be unavailable). Use
/exit, /quit or End session to close it. Restarting the web server terminates
the terminal; Codex saves its own persistent conversations for /resume.
The terminal is shared by users of this instance, like the existing web chat.

The same web authentication and origin checks protect terminal input/output.
The HTTP API can only launch the configured Codex executable with fixed
startup arguments; it does not accept arbitrary process commands. Native
Codex features retain their own host/account requirements. Clipboard export,
voice/audio, IDE and desktop integrations run on the server host; this feature
does not redirect those host services to your browser. Browser file uploads
remain in the Chat view. No claim is made that every platform-specific CLI
feature works on every Linux host.

Requires Codex's experimental process/spawn API (tested with 0.163.0). No
extra Python, PTY helper, WebSocket service or Node runtime dependency was
added. The browser terminal uses vendored @xterm/xterm 6.0.0 and addon-fit
0.11.0 with their license in XTERM-LICENSE. Script loading remains self-only;
inline styles are allowed for xterm's generated theme and geometry styles.

Existing HTTP/HTTPS server (deployment bundle 1.3.1)
--------------------------------------------------
Use proxy/README.txt to serve this container at /codex/ through an existing
host Apache or Nginx server. .env.proxy.example binds the backend privately
at 127.0.0.1:18765. proxy/render.sh generates the matching HTTP/HTTPS include.
The portable bundle adds ./codex-web.sh proxy-setup [port] to configure this
without replacing credentials. Existing host TLS certificates stay on the
web server. The application/runtime image is codex-web:1.4.0.

Full Access switch (1.4.0)
--------------------------
Use the Full Access On/Off switch above the conversation. It is available in
both Chat and Terminal views. Finish or stop the current chat task, or end
an active terminal session, before changing it.

Off: workspace-write sandbox with on-request approvals.
On: danger-full-access sandbox setting with approvalPolicy=never.

The selection applies to the next chat turn, including an existing resumed
conversation, and to newly started native terminals. It is shared by users
of this web instance and saved in /data/conversation.json across restarts,
container replacement and New conversation. No rebuild or restart is needed
to switch. Native /permissions may change a terminal session independently.

A fresh installation defaults to Off. CODEX_WEB_ACCESS_MODE=full-access or
workspace in web.env (portable) or .env (Compose) sets the initial default;
a saved selection from the UI takes precedence over this environment setting.
The old separate Full Access updater is unnecessary and must not be run over
this release, since it contains older application files.

Full Access disables Codex sandbox restrictions and approval prompts. Docker,
OS permissions, read-only mounts and managed Codex policy still apply; it
does not grant access to unmounted host paths or make the container privileged.

Tests cover switching both ways, authentication/origin checks, active-task
locks, failure handling, resumed-thread policy, terminal flags, saved-setting
precedence, browser controls and persistence across container replacement.
