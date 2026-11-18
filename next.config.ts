import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
