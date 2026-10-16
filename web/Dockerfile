# Trading Factory dashboard - Next.js in standalone mode.
FROM node:22-alpine AS deps
WORKDIR /app
COPY web/package*.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=true
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# The household is bootstrapped and members are added from inside the container:
#   docker compose exec web node scripts/create-user.js --email owner@example.com
# Those scripts need the database driver and the shared lib at runtime, so both the scripts and
# their dependencies must be present in the runner image - without this the container starts and
# every admin command fails.
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/lib ./lib
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
