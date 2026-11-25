import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Tailwind v4 through Turbopack's CSS loader (no PostCSS config needed).
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
