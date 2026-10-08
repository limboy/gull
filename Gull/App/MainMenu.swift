import AppKit

/// The menu bar, built in code. Reader commands target the first responder and
/// are answered by the key window's `ReaderWindowController`.
enum MainMenu {
    static func build() -> NSMenu {
        let main = NSMenu()
        main.addItem(submenu(appMenu()))
        main.addItem(submenu(fileMenu()))
        main.addItem(submenu(editMenu()))
        main.addItem(submenu(viewMenu()))
        let window = windowMenu()
        main.addItem(submenu(window))
        NSApp.windowsMenu = window
        let help = NSMenu(title: "Help")
        main.addItem(submenu(help))
        NSApp.helpMenu = help
        return main
    }

    private static func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private static func item(_ title: String, _ action: Selector?, _ key: String = "",
                             _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }

    private static func appMenu() -> NSMenu {
        let menu = NSMenu(title: "Gull")
        menu.addItem(item("About Gull", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp))
        menu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu(title: "Services")
        NSApp.servicesMenu = services.submenu
        menu.addItem(services)
        menu.addItem(.separator())
        menu.addItem(item("Hide Gull", #selector(NSApplication.hide(_:)), "h"))
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        menu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Quit Gull", #selector(NSApplication.terminate(_:)), "q"))
        return menu
    }

    private static func fileMenu() -> NSMenu {
        let menu = NSMenu(title: "File")
        menu.addItem(item("Open…", #selector(AppDelegate.openDocument(_:)), "o", target: AppDelegate.shared))
        menu.addItem(item("Add Book Folder…", #selector(ReaderWindowController.addBookFolder(_:)), "o", [.command, .shift]))
        menu.addItem(item("Show Library", #selector(AppDelegate.showLibrary(_:)), "l", [.command, .shift],
                          target: AppDelegate.shared))
        menu.addItem(.separator())
        menu.addItem(item("Close", #selector(NSWindow.performClose(_:)), "w"))
        return menu
    }

    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(item("Undo", Selector(("undo:")), "z"))
        menu.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        menu.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        menu.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        menu.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        menu.addItem(.separator())
        menu.addItem(item("Highlight Selection", #selector(ReaderWindowController.highlightSelectionCommand(_:)), "h", [.command, .control]))
        menu.addItem(item("Find in Book", #selector(ReaderWindowController.findInBook(_:)), "f"))
        return menu
    }

    private static func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(item("Hide Library", #selector(ReaderWindowController.toggleLibrarySidebar(_:)), "s", [.command, .control]))
        menu.addItem(item("Hide Inspector", #selector(ReaderWindowController.toggleReaderInspector(_:)), "i", [.command, .option]))
        menu.addItem(.separator())
        menu.addItem(item("Contents", #selector(ReaderWindowController.showContents(_:)), "1", [.command, .option]))
        menu.addItem(item("Highlights", #selector(ReaderWindowController.showHighlights(_:)), "2", [.command, .option]))
        menu.addItem(item("Search", #selector(ReaderWindowController.findInBook(_:)), "3", [.command, .option]))
        menu.addItem(.separator())
        menu.addItem(item("Bigger Text", #selector(ReaderWindowController.biggerText(_:)), "+"))
        menu.addItem(item("Smaller Text", #selector(ReaderWindowController.smallerText(_:)), "-"))
        menu.addItem(item("Full Width", #selector(ReaderWindowController.toggleFullWidth(_:))))
        menu.addItem(item("Chapter Scrollbar", #selector(ReaderWindowController.toggleChapterScrollbar(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        return menu
    }

    private static func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        menu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), target: NSApp))
        return menu
    }
}
