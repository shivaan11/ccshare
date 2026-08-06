import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  // Workspace source has no build of its own; bundle it into the CLI.
  noExternal: ["@ccshare/protocol"],
});
