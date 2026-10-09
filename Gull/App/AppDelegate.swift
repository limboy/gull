import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// AppKit owns the lifecycle: one library window, plus a standalone window per
/// book opened from Finder or File › Open (re-opening a book focuses it).
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    static private(set) var shared: AppDelegate!

    private var libraryWindow: ReaderWindowController?
    private var bookWindows: [String: ReaderWindowController] = [:]
    private var openedBookAtLaunch = false

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        shared = delegate
        app.delegate = delegate
        app.run()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.build()
        NSWindow.allowsAutomaticWindowTabbing = false
        #if DEBUG
        // `-GullAppearance dark|light` previews a theme without changing the system's.
        switch UserDefaults.standard.string(forKey: "GullAppearance") {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: break
        }
        #endif
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !openedBookAtLaunch { showLibrary() }
        AppUpdater.shared.start()
        Task { await LibraryStore.shared.refreshAll() }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { LibraryStore.shared.refreshOnActivation() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showLibrary() }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        LibraryStore.shared.flush()
        HighlightStore.shared.flush()
        PositionStore.shared.flush()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL && BookFormat.isSupported(url) {
            openedBookAtLaunch = true
            openBook(url)
        }
    }

    // MARK: Windows

    @objc func showLibrary(_ sender: Any? = nil) {
        if libraryWindow == nil {
            libraryWindow = ReaderWindowController(kind: .library)
        }
        libraryWindow?.showWindow(nil)
        libraryWindow?.window?.makeKeyAndOrderFront(nil)
    }

    func openBook(_ url: URL) {
        let path = url.standardizedFileURL.path
        guard FileManager.default.fileExists(atPath: path) else { return }
        if let existing = bookWindows[path] {
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        let controller = ReaderWindowController(kind: .book(path))
        bookWindows[path] = controller
        controller.onClose = { [weak self] in self?.bookWindows[path] = nil }
        controller.showWindow(nil)
    }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = BookFormat.supportedExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            for url in panel.urls { self?.openBook(url) }
        }
    }
}

/// A library or standalone book window. It sits in the responder chain, so it
/// answers the reader commands in the menu bar for its own model.
final class ReaderWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
    enum Kind: Equatable {
        case library
        case book(String)
    }

    let kind: Kind
    let model: ReaderModel
    let state = WindowState()
    var onClose: (() -> Void)?

    init(kind: Kind) {
        self.kind = kind
        model = ReaderModel(standalone: kind != .library)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .automatic
        window.minSize = NSSize(width: 500, height: 530)
        window.tabbingMode = .disallowed

        let root: AnyView
        switch kind {
        case .library:
            root = AnyView(LibraryWindowView(model: model, state: state))
        case .book(let path):
            root = AnyView(BookWindowView(model: model))
            window.title = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        }
        let hosting = NSHostingController(rootView: root)
        hosting.sceneBridgingOptions = [.toolbars, .title]
        window.contentViewController = hosting
        window.setContentSize(NSSize(width: 1100, height: 780))

        super.init(window: window)
        window.delegate = self

        switch kind {
        case .library:
            window.setFrameAutosaveName("LibraryWindow")
            if !window.setFrameUsingName("LibraryWindow") { window.center() }
        case .book(let path):
            window.setFrameAutosaveName("BookWindow")
            if NSApp.windows.contains(where: { $0.isVisible && $0 !== window }) {
                window.setFrameUsingName("BookWindow")
                window.cascadeTopLeft(from: NSPoint(x: window.frame.minX + 24, y: window.frame.maxY - 24))
            } else if !window.setFrameUsingName("BookWindow") {
                window.center()
            }
            model.open(path)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func windowWillClose(_ notification: Notification) {
        if case .book = kind {
            model.close()
            onClose?()
        }
        PositionStore.shared.flush()
    }

    // MARK: Commands

    @objc func toggleLibrarySidebar(_ sender: Any?) { state.toggleSidebar() }

    @objc func showContents(_ sender: Any?) { model.openPanel = .toc }
    @objc func showHighlights(_ sender: Any?) { model.openPanel = .highlights }
    @objc func findInBook(_ sender: Any?) { model.focusSearch() }
    @objc func highlightSelectionCommand(_ sender: Any?) { model.highlightSelection() }

    @objc func addBookFolder(_ sender: Any?) { LibraryStore.shared.addFolderFromPanel(window: window) }

    @objc func biggerText(_ sender: Any?) { ReaderSettings.shared.stepFontSize(1) }
    @objc func smallerText(_ sender: Any?) { ReaderSettings.shared.stepFontSize(-1) }
    @objc func toggleChapterScrollbar(_ sender: Any?) { ReaderSettings.shared.chapterScrollbar.toggle() }
    @objc func toggleFullWidth(_ sender: Any?) { ReaderSettings.shared.fullWidth.toggle() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let settings = ReaderSettings.shared
        switch item.action {
        case #selector(toggleLibrarySidebar(_:)):
            item.title = state.columnVisibility == .detailOnly ? "Show Library" : "Hide Library"
            return kind == .library
        case #selector(addBookFolder(_:)):
            return kind == .library
        case #selector(highlightSelectionCommand(_:)), #selector(findInBook(_:)),
             #selector(showContents(_:)), #selector(showHighlights(_:)):
            return model.hasBook
        case #selector(biggerText(_:)), #selector(smallerText(_:)):
            return !model.isPDF
        case #selector(toggleChapterScrollbar(_:)):
            item.state = settings.chapterScrollbar ? .on : .off
            return true
        case #selector(toggleFullWidth(_:)):
            item.state = settings.fullWidth ? .on : .off
            return !model.isPDF
        default:
            return true
        }
    }
}
