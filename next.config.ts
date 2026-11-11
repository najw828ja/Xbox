import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone لل استضافة الذاتية فقط — على Vercel نتركه الافتراضي
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
