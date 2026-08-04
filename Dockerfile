# A long-running Node process, not a serverless function.
#
# A sweep takes between one and twelve minutes and runs DETACHED after its HTTP
# response returns: `POST /api/map` answers in a millisecond with a run id and
# the work carries on in the background. Serverless kills the instance when the
# response is sent, so on that platform every run would die immediately after
# starting. It needs a host that keeps the process alive between requests:
# Railway, Render, Fly, or any box running `node`.
#
# Spans stream to Postgres as the run goes, so a browser attaching to a run this
# process did not start still gets it, and a process that dies mid-run leaves a
# readable partial rather than nothing.

FROM node:20-slim AS build
WORKDIR /app

RUN corepack enable

# The workspace, copied in dependency order so a source edit does not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json      packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/sweep/package.json     packages/sweep/
COPY packages/web/package.json       packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
# The prompts are read from disk at run time, not bundled, so they must be in
# the image. `promptsRoot()` walks up looking for prompts/doctrine.
RUN pnpm --filter @open-kb/core --filter @open-kb/providers --filter @open-kb/sweep exec tsc -b \
 && pnpm --filter @open-kb/web build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# Localhost cookies are shared across ports, and a neighbouring dev server once
# pushed request headers past Node's 16KB default and returned 431 on every page.
ENV NODE_OPTIONS=--max-http-header-size=65536

RUN corepack enable
COPY --from=build /app ./

# Where finished runs land when Postgres is not configured. Ephemeral on most
# hosts, which is exactly why SUPABASE_URL matters in a deployment.
ENV OPENKB_RUNS_DIR=/app/runs
RUN mkdir -p /app/runs

# The host assigns this; the start script binds ${PORT:-3210}. Hard-coding a
# port means the platform health-checks a closed socket and fails the deploy.
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@open-kb/web", "start"]
