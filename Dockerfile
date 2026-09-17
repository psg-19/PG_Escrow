# The API, containerised.
#
# It must be a long-running process, not a serverless function: adjudication
# runs as an in-memory background job that outlives the HTTP request that
# started it. A platform that freezes the process after responding would kill
# every dispute mid-panel.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first, so a dependency-only change reuses the layer.
COPY package.json package-lock.json* ./
COPY packages/core/package.json        packages/core/
COPY packages/db/package.json          packages/db/
COPY packages/evidence/package.json    packages/evidence/
COPY packages/judge/package.json       packages/judge/
COPY packages/contracts/package.json   packages/contracts/
COPY apps/api/package.json             apps/api/

# Dev dependencies are needed: the API runs TypeScript through tsx, and the
# contract ABIs come from a Hardhat compile.
RUN npm ci --include=dev --workspace=@pg/api \
    --workspace=@pg/core --workspace=@pg/db \
    --workspace=@pg/evidence --workspace=@pg/judge \
    --workspace=@pg/contracts --include-workspace-root

COPY packages/ packages/
COPY apps/api/ apps/api/

# The ABIs are read from disk at runtime, so they have to be in the image.
RUN npx hardhat compile --config packages/contracts/hardhat.config.ts 2>/dev/null \
    || (cd packages/contracts && npx hardhat compile)

EXPOSE 4000
ENV PORT=4000

# No .env in the image — secrets come from the platform's environment.
CMD ["npx", "tsx", "apps/api/src/server.ts"]
