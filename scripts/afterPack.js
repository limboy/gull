const fs = require("fs");
const path = require("path");
const plist = require("plist");

// Inject pre-built Assets.car and CFBundleIconName into the app bundle so the
// macOS Tahoe dynamic icon works without requiring actool 26 in CI.
exports.default = async function afterPack({ appOutDir, packager }) {
  if (packager.platform.name !== "mac") return;

  const appName = packager.appInfo.productName;
  const contentsPath = path.join(appOutDir, `${appName}.app`, "Contents");
  const resourcesPath = path.join(contentsPath, "Resources");
  const assetsSrc = path.resolve(__dirname, "../assets/Assets.car");

  if (!fs.existsSync(assetsSrc)) return;

  fs.copyFileSync(assetsSrc, path.join(resourcesPath, "Assets.car"));

  const infoPlistPath = path.join(contentsPath, "Info.plist");
  const info = plist.parse(fs.readFileSync(infoPlistPath, "utf8"));
  info.CFBundleIconName = "Icon";
  fs.writeFileSync(infoPlistPath, plist.build(info));
};
