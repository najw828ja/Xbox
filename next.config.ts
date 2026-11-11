import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone لل استضافة الذاتية فقط — على Vercel نتركه الافتراضي
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  // ثنائيات ffmpeg/ffprobe يجب أن تبقى خارج الحزمة (تعتمد على __dirname للعثور على الملف التنفيذي)
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
