# Playwright's official image already carries Chromium plus every system
# library it needs. Building from node:slim instead means hunting missing
# .so files, which is a well-known time sink.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Dependencies first so this layer caches across code changes.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY templates ./templates
RUN mkdir -p out

EXPOSE 8080

# Fails the container if the service stops responding, so an orchestrator can
# restart it rather than leaving a dead endpoint that n8n keeps calling.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
