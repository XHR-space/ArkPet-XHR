const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function findRcedit(root) {
  const bundled = path.join(
    root,
    "node_modules",
    "rcedit",
    "bin",
    "rcedit-x64.exe"
  );
  if (fs.existsSync(bundled)) return bundled;
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "electron-builder",
    "Cache",
    "winCodeSign"
  );
  if (fs.existsSync(cacheRoot)) {
    const cached = fs.readdirSync(cacheRoot)
      .map((entry) => path.join(cacheRoot, entry, "rcedit-x64.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    if (cached[0]) return cached[0];
  }
  const vendored = path.join(
    root,
    "node_modules",
    "electron-winstaller",
    "vendor",
    "rcedit.exe"
  );
  if (fs.existsSync(vendored)) return vendored;
  return "";
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = path.resolve(__dirname, "..");
  const packageJson = require(path.join(root, "package.json"));
  const rcedit = findRcedit(root);
  if (!rcedit) throw new Error("找不到 rcedit，无法写入 ArkPet 可执行文件信息。");
  const executable = path.join(context.appOutDir, "ArkPet.exe");
  if (!fs.existsSync(executable)) return;
  execFileSync(
    rcedit,
    [
      executable,
      "--set-icon",
      path.join(root, "build", "icon.ico"),
      "--set-file-version",
      packageJson.version,
      "--set-product-version",
      packageJson.version,
      "--set-version-string",
      "ProductName",
      "ArkPet",
      "--set-version-string",
      "FileDescription",
      "ArkPet",
      "--set-version-string",
      "InternalName",
      "ArkPet",
      "--set-version-string",
      "OriginalFilename",
      "ArkPet.exe",
      "--set-version-string",
      "LegalCopyright",
      packageJson.build.copyright
    ],
    { stdio: "inherit" }
  );
};
