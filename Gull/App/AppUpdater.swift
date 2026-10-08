import AppKit
import Observation
import Sparkle

/// Sparkle auto-update, matching the Electron app's behavior: check on launch
/// and every 6 hours, download in the background, install on quit, and show a
/// "Restart to Update" pill in the toolbar once an update is ready.
@Observable
final class AppUpdater: NSObject {
    static let shared = AppUpdater()

    /// The version downloaded and waiting to be installed, if any.
    private(set) var readyVersion: String?

    @ObservationIgnored private var installNow: (() -> Void)?
    @ObservationIgnored private lazy var controller = SPUStandardUpdaterController(
        startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)

    /// Updates need an EdDSA public key and a feed; local builds have neither.
    var isConfigured: Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        let key = (info["SUPublicEDKey"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let feed = (info["SUFeedURL"] as? String) ?? ""
        return !key.isEmpty && !key.hasPrefix("$(") && feed.hasPrefix("https://")
    }

    func start() {
        #if DEBUG
        return
        #else
        guard isConfigured else { return }
        controller.startUpdater()
        #endif
    }

    /// Target/action pair for the "Check for Updates…" menu item. Sparkle's
    /// controller validates the item itself (disabled while a check runs).
    var menuTarget: AnyObject? { isConfigured ? controller : nil }

    func restartToUpdate() {
        installNow?()
    }
}

extension AppUpdater: SPUUpdaterDelegate {
    /// Sparkle has the update staged and would install it on quit; keep the
    /// block so the toolbar pill can install and relaunch right away.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock: @escaping () -> Void) -> Bool {
        readyVersion = item.displayVersionString
        installNow = immediateInstallationBlock
        return true
    }
}
