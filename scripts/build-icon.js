const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ASSETS_DIR = path.resolve(__dirname, "../assets");
const ICON_PACKAGE = path.join(ASSETS_DIR, "icon.icon");
const COMMITTED_ICNS = path.join(ASSETS_DIR, "icon.icns");
const COMMITTED_CAR = path.join(ASSETS_DIR, "Assets.car");

if (!fs.existsSync(ICON_PACKAGE)) {
  console.error("assets/icon.icon not found");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icon-compile-"));
try {
  const iconCopy = path.join(tmp, "Icon.icon");
  fs.cpSync(ICON_PACKAGE, iconCopy, { recursive: true });
  execFileSync("actool", [
    iconCopy,
    "--compile", tmp,
    "--output-format", "human-readable-text",
    "--notices", "--warnings",
    "--output-partial-info-plist", path.join(tmp, "info.plist"),
    "--app-icon", "Icon",
    "--include-all-app-icons",
    "--accent-color", "AccentColor",
    "--enable-on-demand-resources", "NO",
    "--development-region", "en",
    "--target-device", "mac",
    "--minimum-deployment-target", "12.0",
    "--platform", "macosx",
  ], { stdio: "inherit" });
  fs.copyFileSync(path.join(tmp, "Icon.icns"), COMMITTED_ICNS);
  fs.copyFileSync(path.join(tmp, "Assets.car"), COMMITTED_CAR);
  console.log("Generated assets/icon.icns and assets/Assets.car");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
