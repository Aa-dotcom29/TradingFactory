# Harness image: reuses the existing angel-feed.js (auth/TOTP/instrument master) so we do
# not reimplement broker integration. Runs as the non-root "node" user.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only what the harness needs: shared feed module + harness sources.
COPY angel-feed.js ./
COPY harness ./harness

USER node

ENV HARNESS_ROLE=all
CMD ["node", "harness/src/run.js"]
