import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Standalone output is only needed for the Docker image (it bundles a minimal server).
// Building it unconditionally makes plain `next start` unsupported locally, so it is
// opt-in via NEXT_OUTPUT_STANDALONE, which web/Dockerfile sets.
const standalone = process.env.NEXT_OUTPUT_STANDALONE === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The repo root also has a package-lock.json; pin tracing to this app so the
  // standalone output does not try to include unrelated files.
  outputFileTracingRoot: projectRoot,
  ...(standalone ? { output: 'standalone' } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  // postgres-js must stay a real Node dependency, not be bundled.
  serverExternalPackages: ['postgres'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
