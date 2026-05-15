const fs = require("fs");
const path = require("path");
const os = require("os");
const plist = require("plist");
const { execFileSync } = require("child_process");

const ASSETS_DIR = path.resolve(__dirname, "../assets");
const ICON_PACKAGE = path.join(ASSETS_DIR, "icon.icon");
const COMMITTED_ICNS = path.join(ASSETS_DIR, "icon.icns");
const COMMITTED_CAR = path.join(ASSETS_DIR, "Assets.car");

function getActoolVersion() {
  try {
    const out = execFileSync("actool", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const match = out.match(/<string>([\d.]+)<\/string>/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function hasActool26() {
  const ver = getActoolVersion();
  if (!ver) return false;
  const [major] = ver.split(".").map(Number);
  return major >= 26;
}

function generateFromIconPackage() {
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
    return {
      icns: fs.readFileSync(path.join(tmp, "Icon.icns")),
      car: fs.readFileSync(path.join(tmp, "Assets.car")),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

exports.default = async function afterPack({ appOutDir, packager }) {
  if (packager.platform.name !== "mac") return;

  const appName = packager.appInfo.productName;
  const contentsPath = path.join(appOutDir, `${appName}.app`, "Contents");
  const resourcesPath = path.join(contentsPath, "Resources");

  let car, icns;

  if (fs.existsSync(ICON_PACKAGE) && hasActool26()) {
    console.log("  • actool 26+ found — regenerating icon assets from assets/icon.icon");
    try {
      ({ icns, car } = generateFromIconPackage());
      // Keep committed files in sync so CI always has up-to-date assets.
      fs.writeFileSync(COMMITTED_ICNS, icns);
      fs.writeFileSync(COMMITTED_CAR, car);
    } catch (e) {
      console.error(`  • actool regeneration failed: ${e.message}`);
      if (fs.existsSync(COMMITTED_ICNS) && fs.existsSync(COMMITTED_CAR)) {
        console.log("  • falling back to pre-built icon assets");
        icns = fs.readFileSync(COMMITTED_ICNS);
        car = fs.readFileSync(COMMITTED_CAR);
      } else {
        throw e;
      }
    }
  } else {
    if (!fs.existsSync(COMMITTED_CAR)) return;
    console.log("  • actool 26 not available — using pre-built icon assets");
    icns = fs.readFileSync(COMMITTED_ICNS);
    car = fs.readFileSync(COMMITTED_CAR);
  }

  fs.writeFileSync(path.join(resourcesPath, "icon.icns"), icns);
  fs.writeFileSync(path.join(resourcesPath, "Assets.car"), car);

  const infoPlistPath = path.join(contentsPath, "Info.plist");
  const info = plist.parse(fs.readFileSync(infoPlistPath, "utf8"));
  info.CFBundleIconName = "Icon";
  fs.writeFileSync(infoPlistPath, plist.build(info));
};
