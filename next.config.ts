import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project so Turbopack does not pick up a
  // parent lockfile (there is an unrelated package-lock.json higher up).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
