REUSE AN EXISTING HTTP OR HTTPS SERVER
====================================

The existing host Apache or Nginx serves /codex/ and forwards requests to
Codex's private Docker port. Other website paths keep their existing behavior.
HTTPS terminates at that server, using its existing hostname and certificate.
The container continues to use HTTP over localhost; it does not need copies
of your TLS certificate/private key and does not claim host ports 80 or 443.

These snippets assume Apache/Nginx runs on the same Linux host as Docker.
They preserve the original Host header (including a nonstandard public port),
allow the UI's upload sizes, and avoid buffering/compressing event streams.
Both chat and native terminal use HTTP/SSE; no WebSocket endpoint is required.

PORTABLE BUNDLE: QUICK START
----------------------------
From codex-web-portable/:

  ./codex-web.sh stop                 # if this bundle is already running
  ./codex-web.sh proxy-setup          # defaults to private port 18765
  ./codex-web.sh login                # first use only
  ./codex-web.sh start

proxy-setup initializes the bundle if needed, preserves existing credentials,
sets BIND_ADDRESS=127.0.0.1 and WEB_PORT=18765 in web.env, and writes:
  proxy/apache.conf
  proxy/nginx.conf

It does not change or reload the host's web-server configuration. It refuses
to change ports while a container for this bundle exists: stop it first so
start creates a container with the new mapping. Login, chats, uploads and
workspace files are retained. To choose another unused localhost port:

  ./codex-web.sh proxy-setup 18766

Install ONE matching snippet as described below, then access your existing
site's /codex/ URL, for example https://your-existing-host/codex/ or
http://your-server-ip/codex/ when that is the host serving your site.
The existing Codex web username/password still apply.

APACHE
------
Automated setup for a systemd httpd service (run on the Docker host):
  sudo python3 /path/to/setup-httpd.py \
    --bundle /absolute/path/to/codex-web-portable

The script reads the running service's executable, configuration arguments
and environment, then asks Apache for its active includes and virtual hosts.
It selects the only port-80 site, or the main server when no virtual hosts
exist. If several sites exist, use --site your-existing-hostname (ServerName).
Use --config /etc/httpd/conf.d/your-site.conf to select an active file explicitly.
Add --dry-run to preview the file and diff without changing files or services.

The script enables installed modules listed below when needed, backs up each
modified config (including the main config for module loading), adds a
managed /codex/ block, runs stop/proxy-setup/start, validates and reloads httpd.
For the existing main-server Codex localhost proxy, it updates the two backend
URLs in the included config instead of adding another route. Unrecognized or
conflicting routes require manual migration; ambiguous sites need selection.
On failure it restores the Apache config; container changes are not undone.
Use --port 18766 to select a different private backend port. First-time Codex
sign-in remains ./codex-web.sh login. The following is the manual alternative.

For manual setup, enable mod_proxy, mod_proxy_http, mod_alias and mod_env. On Debian/Ubuntu:
  sudo a2enmod proxy proxy_http alias env
On other distributions, use their existing LoadModule configuration.

Inside the existing <VirtualHost *:80> or <VirtualHost *:443>, add:
  Include "/absolute/path/to/codex-web-portable/proxy/apache.conf"

Use the HTTPS virtual host when HTTP already redirects to HTTPS. Keep the
existing TLS directives/certificates. Put the Codex ProxyPass/include before
any broader ProxyPass / rule. If /codex/ is already configured, update that
route instead of adding a duplicate.

Validate and reload the existing server, using its installed service name:
  sudo apachectl configtest
  sudo systemctl reload apache2      # Debian/Ubuntu
or:
  sudo httpd -t
  sudo systemctl reload httpd        # RHEL/Photon and similar

NGINX
-----
Inside the existing HTTP or HTTPS server { } block, add:
  include /absolute/path/to/codex-web-portable/proxy/nginx.conf;

Keep listen, server_name, ssl_certificate and ssl_certificate_key as they
already are. Use the HTTPS block if the HTTP block redirects to HTTPS.
Replace any existing /codex location instead of defining it twice. An
existing server-level rewrite/return may need to exclude /codex/ so requests
can reach this location.

Validate and reload:
  sudo nginx -t
  sudo systemctl reload nginx

SOURCE / DOCKER COMPOSE DEPLOYMENT
---------------------------------
This option uses Compose's named volumes, separate from the portable launcher.
For a fresh deployment, copy .env.proxy.example to .env, set a strong unique
CODEX_WEB_PASSWORD, and chmod 600 .env. For an existing deployment, preserve
its credentials and change only these entries in .env:
  BIND_ADDRESS=127.0.0.1
  WEB_PORT=18765

  docker compose up -d
  ./proxy/render.sh apache 18765 > proxy/apache.conf
  ./proxy/render.sh nginx 18765 > proxy/nginx.conf

Follow the corresponding web-server instructions above, with the source
folder's actual path. Keep existing volumes when recreating the container.
For raw Docker, publish the private port with:
  -p 127.0.0.1:18765:8765
instead of a public 0.0.0.0 binding. Keep your existing volumes/env-file.

CHECKS AND TROUBLESHOOTING
--------------------------
Open the public /codex/ URL: verify login, send a message, attach a file, and
open the native terminal. An unauthenticated request should return 401:
  curl -sS -o /dev/null -w '%{http_code}\n' https://your-existing-host/codex/

502: confirm the container is running and the generated port matches web.env.
403 when sending: preserve Host, including its public port, as the snippets do.
413: check additional outer proxy/WAF request limits; JSON/base64 uploads need
up to 30 MiB of HTTP request capacity for the UI's 20 MiB attachment total.
Delayed output: check outer proxies too; SSE responses must not be buffered.
On SELinux hosts, the web server also needs permission to connect to the local
backend under the host's existing policy.

A proxy running in another container cannot reach the host's backend via its
own 127.0.0.1. That topology needs a shared Docker network and an upstream such
as codex-web:8765 instead; these host-proxy snippets do not configure it.

Validation: tests/proxy.py starts isolated Apache 2.4 and Nginx listeners,
with temporary self-signed HTTPS certificates, against the real Codex web
container using mock Codex RPC. It checks existing-site paths, authentication,
Host/Origin handling, uploads larger than Nginx's default 1 MiB, and immediate
chat/terminal event streaming over HTTP and HTTPS. No host configuration is
changed and no model inference is needed by this test.

References:
https://httpd.apache.org/docs/2.4/mod/mod_proxy.html
https://nginx.org/en/docs/http/ngx_http_proxy_module.html

RECOVER MISSING HOST DIRECTORIES WHILE THE CONTAINER IS RUNNING
-------------------------------------------------------------
Let active Codex work finish, then run as root on the Linux Docker host:
  python3 proxy/recover-running-bundle.py --bundle "$PWD"

This reads the original bundle path from the container label and accesses its
live /data and /workspace mounts via /proc. It pauses the container, snapshots
and verifies file content, ownership, permissions and symlinks, then restores
the original folder, launcher assets and web credentials. It retains private
.codex-recovery-* snapshots and any replaced destination files. Only after
successful verification does it resume/stop the original container and run
setup-httpd.py against the recovered bundle. Copy/verification failures resume
the original container without stopping it. Missing live /data/codex requires
manual recovery; the script will not stop the container in that case.
Allow disk space for two copies of the recovered data plus the runtime image.
