AI WEB WITH AN EXISTING HTTP/HTTPS SERVER

Automatic port-80 setup (requires Python 3):
  sudo ./ai-web.sh setup

It reuses active httpd.service. Without that service, it starts the bundled
web server directly if port 80 is free. Other existing servers are left alone.
No Apache installation is needed for direct mode. An existing container on
another port must be stopped when idle before switching to direct port 80.

For explicit Apache setup from ai-web-portable on the Docker host:
  python3 proxy/setup-httpd.py --bundle "$PWD" --dry-run
  python3 proxy/setup-httpd.py --bundle "$PWD"

Run as root. This detects systemd httpd.service configuration and adds /ai/,
/codex/ and /claude/ pointing to one localhost port (18760 by default).
Use --site hostname or --config /absolute/active/site.conf for multiple sites.
For HTTPS, select the existing TLS virtual host; certificates stay with httpd.
The script backs up modified files, enables installed Apache modules, validates,
and reloads. Apache config is restored on error; container changes are not.
Old unmanaged routes for any of these paths must be migrated explicitly first.
An old combined managed block can be updated by rerunning setup.

Manual setup (also works with non-systemd servers):
  ./ai-web.sh stop
  ./ai-web.sh proxy-setup 18760
  ./ai-web.sh start

Apache: enable proxy, proxy_http, alias and env modules, then inside the
existing HTTP or HTTPS VirtualHost add:
  Include "/absolute/path/to/ai-web-portable/proxy/apache.conf"
Validate with httpd -t or apachectl configtest, then reload the existing service.
Put these proxy paths before broader ProxyPass / rules.

Nginx: inside the existing HTTP or HTTPS server block add:
  include /absolute/path/to/ai-web-portable/proxy/nginx.conf;
Validate with nginx -t, then reload the existing service.

Open http(s)://<existing-host>/ai/. Both UIs use the credentials from web.env.
Keep existing Listen, TLS and unrelated website settings. Replace conflicting
old /ai/, /codex/ or /claude/ route blocks rather than adding duplicates.
These templates assume the web server runs on the Docker host, not in another
container. A containerized proxy needs a shared network and container upstream.

Troubleshooting:
- 502: check ./ai-web.sh status and matching backend ports.
- 403 on POST: preserve Host including its public port.
- 413: all outer proxies must allow 30 MiB HTTP bodies for base64 uploads.
- Delayed streaming: turn off proxy buffering/compression on these routes.
- SELinux hosts may need their normal policy for httpd localhost connections.

No second server binds host port 80 or 443. The container only publishes its
private localhost port, while httpd/Nginx terminates existing HTTPS.
