import esbuild from "esbuild";

const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  logLevel: "info",
};

// Server library: PeerTube requires it via CommonJS.
await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  platform: "node",
  format: "cjs",
  target: "node18",
});

// Client scripts: loaded by PeerTube as ES modules.
const clientEntries = {
  "dist/client/video-watch-client-plugin.js": "src/client/video-watch.ts",
};

for (const [outfile, entry] of Object.entries(clientEntries)) {
  await esbuild.build({
    ...shared,
    entryPoints: [entry],
    outfile,
    platform: "browser",
    format: "esm",
    target: "es2019",
  });
}

console.log("Build complete.");
