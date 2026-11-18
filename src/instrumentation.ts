/** Runs once when the Next.js server starts: load the local embedding model in the background. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmUp } = await import("./lib/embeddings");
    warmUp();
  }
}
