FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
# --include=optional forces npm to honor platform-specific optional deps
# (rollup's native binaries) even when an inherited package-lock.json
# pruned them out for a different arch. Works around the long-standing
# npm bug at https://github.com/npm/cli/issues/4828.
#
# Note we use node:20-slim (Debian glibc) rather than node:20-alpine
# (musl) because rollup's musl native binary (@rollup/rollup-linux-x64-musl)
# is one of the optional packages most often silently skipped by the npm
# bug. The glibc variant (@rollup/rollup-linux-x64-gnu) is more reliable.
RUN npm install --include=optional

COPY . .

EXPOSE 5173
