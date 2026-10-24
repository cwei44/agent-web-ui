FROM node:22-alpine3.22 AS dependencies
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr/local npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:22-alpine3.22
ARG CLAUDE_VERSION=2.1.310
RUN apk add --no-cache ca-certificates bash git python3 curl ripgrep tini libstdc++ libgcc \
 && npm install --global @anthropic-ai/claude-code@${CLAUDE_VERSION} \
 && npm cache clean --force
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8766 DATA_DIR=/data WORKSPACE_DIR=/workspace \
    CLAUDE_CONFIG_DIR=/data/claude HOME=/data/home CLAUDE_BIN=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY server.js options.js files.js app.js index.html style.css terminal.js xterm.js xterm-fit.js xterm.css XTERM-LICENSE healthcheck.js package.json ./
RUN chmod 644 /app/*.* && mkdir -p /data/claude /data/home /workspace && chown -R node:node /data /workspace
USER node
EXPOSE 8766
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.js"]
