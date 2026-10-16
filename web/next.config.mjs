import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a self-contained server bundle for the Docker image.
  output: 'standalone',
  // The repo root also has a package-lock.json; pin tracing to this app so the
  // standalone output does not try to include unrelated files.
  outputFileTracingRoot: projectRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  // postgres-js must stay a real Node dependency, not be bundled.
  serverExternalPackages: ['postgres'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
