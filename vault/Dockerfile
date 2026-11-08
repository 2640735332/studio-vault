# Vault API image (zero runtime dependencies: Node standard library only).
# Build context = vault/ (see deploy/docker-compose.yml).
FROM node:22-alpine

WORKDIR /app

# No npm install: the service and its CLI scripts use only the Node standard library.
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY README.md ./

ENV NODE_ENV=production \
    VAULT_BIND=0.0.0.0 \
    VAULT_PORT=3460 \
    VAULT_DB=pg \
    VAULT_LOG_LEVEL=info

EXPOSE 3460
USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VAULT_PORT||3460)+'/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
