FROM codex-web:1.4.0 AS codex
FROM claude-web:1.0.0
USER root
COPY --from=codex /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
WORKDIR /suite
COPY gateway.js healthcheck.js ./
COPY codex/ ./codex/
COPY claude/ ./claude/
RUN ln -s /app/node_modules /suite/claude/node_modules \
 && chmod -R a+rX /suite \
 && mkdir -p /data/codex/codex /data/codex/home /data/claude/claude /data/claude/home /workspace \
 && chown -R node:node /data /workspace
ENV PORT=8760 HOST=0.0.0.0 DATA_DIR=/data WORKSPACE_DIR=/workspace \
    AI_WEB_PROVIDERS=both CODEX_HOME=/data/codex/codex CLAUDE_CONFIG_DIR=/data/claude/claude
USER node
EXPOSE 8760
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/suite/healthcheck.js"]
CMD ["node", "/suite/gateway.js"]
