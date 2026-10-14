import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    root: process.cwd(),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async rewrites() {
    return [
      // Task 68 — Android TWA Digital Asset Links verification file
      { source: "/.well-known/assetlinks.json", destination: "/api/well-known/assetlinks.json" },
    ];
  },
};

export default nextConfig;
