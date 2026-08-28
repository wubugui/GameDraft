// Resolve the project Python interpreter and run a tools.<module> entry.
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

function resolvePython() {
  // Windows 的 venv 布局是 Scripts/python.exe，不是 bin/python。少了这一条，
  // Windows 上会一路掉到 PATH 上的 `python3`——而那通常是微软商店的 stub：
  // 它不报错、不执行、直接退出，于是工具"跑过了"但什么都没发生。
  const candidates = [
    path.join(repoRoot, ".tools", "venv", "bin", "python"),
    path.join(repoRoot, ".tools", "venv", "Scripts", "python.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
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
