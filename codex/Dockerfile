FROM node:22-alpine3.22
ARG CODEX_VERSION=0.163.0
RUN apk add --no-cache ca-certificates bash git python3 curl ripgrep tini \
 && npm install --global @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    CODEX_HOME=/data/codex
WORKDIR /app
COPY server.js app.js index.html style.css terminal.js xterm.js xterm-fit.js xterm.css XTERM-LICENSE healthcheck.js ./
RUN chmod 644 /app/* && mkdir -p /data/codex /workspace && chown -R node:node /data /workspace
USER node
EXPOSE 8765
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.js"]
