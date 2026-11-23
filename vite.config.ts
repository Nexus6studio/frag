import { defineConfig } from "vite";
import { shortBuildId } from "./src/build.ts";

// tsconfig sets `types` to [], so this file cannot import node:child_process.
// The loader stays inside a string so the client bundle never sees it.
function readGitShort(): Promise<string | null> {
  const read = new Function(
    "return import('node:child_process').then((child) => child.execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()).catch(() => null)",
  ) as () => Promise<string | null>;
  return read();
}

function githubSha(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.GITHUB_SHA;
}

// GITHUB_SHA on a pull-request workflow is the merge commit into the base,
// not the branch head. Local builds use `git rev-parse --short HEAD`.
export default defineConfig(async () => {
  const id = shortBuildId(githubSha(), await readGitShort());
  return {
    define: {
      __FRAG_BUILD__: JSON.stringify(id),
    },
    server: {
      host: "127.0.0.1",
    },
    preview: {
      host: "127.0.0.1",
      strictPort: true,
    },
    build: {
      // three.js is one chunk. The drone and pickup code put it just over 600 kB.
      chunkSizeWarningLimit: 640,
    },
  };
});
