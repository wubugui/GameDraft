// Resolve the project Python interpreter and run a tools.<module> entry.
// Cross-platform replacement for the hardcoded ".\\.tools\\Python311\\python.exe"
// invocations in package.json. Resolution order mirrors tools/dev/paths.py.
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

function resolvePython() {
  const candidates =
    process.platform === "win32"
      ? [path.join(repoRoot, ".tools", "Python311", "python.exe")]
      : [path.join(repoRoot, ".tools", "venv", "bin", "python")];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to a system interpreter on PATH.
  return process.platform === "win32" ? "python" : "python3";
}

const [, , moduleName, ...rest] = process.argv;
if (!moduleName) {
  console.error("usage: node scripts/pytool.cjs <tools-module> [args...]");
  process.exit(2);
}

const python = resolvePython();
const result = spawnSync(python, ["-m", `tools.${moduleName}`, ...rest], {
  stdio: "inherit",
  cwd: repoRoot,
});
process.exit(result.status === null ? 1 : result.status);
