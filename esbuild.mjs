import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}

