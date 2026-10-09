import SwiftUI

/// Per-window chrome state the menu bar can reach (sidebar visibility).
@Observable
final class WindowState {
    var columnVisibility: NavigationSplitViewVisibility {
        didSet { UserDefaults.standard.set(columnVisibility == .detailOnly, forKey: "librarySidebarHidden") }
    }

    init() {
        columnVisibility = UserDefaults.standard.bool(forKey: "librarySidebarHidden") ? .detailOnly : .all
    }

    func toggleSidebar() {
        withAnimation { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
    }
}

/// The main window: library sidebar, reader, and inspector.
struct LibraryWindowView: View {
    @Bindable var model: ReaderModel
    @Bindable var state: WindowState
    @Bindable private var library = LibraryStore.shared

    var body: some View {
        NavigationSplitView(columnVisibility: $state.columnVisibility) {
            LibrarySidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 440)
        } detail: {
            ReaderDetailView(model: model)
                .readerChrome(model: model)
        }
        .onChange(of: library.activePath, initial: true) { _, path in
            // A selected folder row isn't a book: show the empty reader instead.
            var isDirectory: ObjCBool = false
            let isFolder = path.map { FileManager.default.fileExists(atPath: $0, isDirectory: &isDirectory) } == true
                && isDirectory.boolValue
            model.open(isFolder ? nil : path)
        }
        .frame(minWidth: 500, minHeight: 530)
    }
}

/// A window for a single book opened from Finder or File › Open. It has no
/// library sidebar and never touches library state.
struct BookWindowView: View {
    @Bindable var model: ReaderModel

    var body: some View {
        ReaderDetailView(model: model)
            .readerChrome(model: model)
            .frame(minWidth: 500, minHeight: 530)
    }
}

private struct ReaderChrome: ViewModifier {
    @Bindable var model: ReaderModel

    func body(content: Content) -> some View {
        content
        .toolbar {
            if let version = AppUpdater.shared.readyVersion {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        AppUpdater.shared.restartToUpdate()
                    } label: {
                        Label("Restart to Update", systemImage: "arrow.down.circle")
                            .labelStyle(.titleAndIcon)
                    }
                    .tint(.orange)
                    .help("Gull \(version) is ready to install")
                }
            }
            // One item group so the toolbar draws the three as a single glass capsule.
            ToolbarItemGroup(placement: .primaryAction) {
                ForEach(InspectorMode.allCases) { PanelButton(model: model, mode: $0) }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                ReadingSettingsMenu(model: model)
            }
        }
        .navigationTitle(model.title.isEmpty ? "Gull" : model.title)
        .navigationSubtitle(model.currentTocTitle ?? "")
    }
}

/// A toolbar button for contents, highlights, or search, opening that panel
/// in a popover anchored to it.
private struct PanelButton: View {
    @Bindable var model: ReaderModel
    let mode: InspectorMode

    var body: some View {
        Button {
            model.openPanel = model.openPanel == mode ? nil : mode
        } label: {
            Label(mode.title, systemImage: mode.symbol)
        }
        .help(mode.title)
        .popover(isPresented: Binding(
            get: { model.openPanel == mode },
            set: { if !$0, model.openPanel == mode { model.openPanel = nil } }
        ), arrowEdge: .bottom) {
            InspectorView(model: model, mode: mode)
        }
    }
}

extension View {
    func readerChrome(model: ReaderModel) -> some View { modifier(ReaderChrome(model: model)) }
}

/// The toolbar's reading settings: typography for reflowable books, page zoom for PDFs.
struct ReadingSettingsMenu: View {
    let model: ReaderModel
    @Bindable private var settings = ReaderSettings.shared

    var body: some View {
        Menu {
            Toggle("Chapter Scrollbar", isOn: $settings.chapterScrollbar)
            Divider()
            if model.isPDF {
                Picker("Zoom", selection: $settings.pdfZoom) {
                    ForEach(PDFZoom.options, id: \.value) { Text($0.label).tag($0.value) }
                }
                .pickerStyle(.inline)
            } else {
                Toggle("Paginated", isOn: $settings.paginated)
                Toggle("Full Width", isOn: $settings.fullWidth)
                Divider()
                Picker(selection: $settings.font) {
                    ForEach(ReadingFont.allCases) { Text($0.label).tag($0) }
                } label: {
                    Label("Font", systemImage: "textformat")
                }
                Picker(selection: $settings.fontSize) {
                    ForEach(ReaderSettings.fontSizes, id: \.value) { Text($0.label).tag($0.value) }
                } label: {
                    Label("Font Size", systemImage: "textformat.size")
                }
                Picker(selection: $settings.lineHeight) {
                    ForEach(ReaderSettings.lineHeights, id: \.value) { Text($0.label).tag($0.value) }
                } label: {
                    Label("Line Height", systemImage: "arrow.up.and.down.text.horizontal")
                }
                Picker(selection: $settings.paraSpacing) {
                    ForEach(ReaderSettings.paragraphSpacings, id: \.value) { Text($0.label).tag($0.value) }
                } label: {
                    Label("Paragraphs", systemImage: "text.justify.left")
                }
            }
        } label: {
            Label("Reading Settings", systemImage: "textformat.size")
        }
        .help("Reading Settings")
    }
}
