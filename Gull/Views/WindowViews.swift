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
        .readerInspector(model: model)
        .onChange(of: library.activePath, initial: true) { _, path in model.open(path) }
        .frame(minWidth: 500, minHeight: 530)
    }
}

/// A window for a single book opened from Finder or File › Open. It has no
/// library sidebar and never touches library state.
struct BookWindowView: View {
    @Bindable var model: ReaderModel

    var body: some View {
        // A split view with no sidebar, so the inspector gets the same
        // full-height column it has in the library window.
        NavigationSplitView(columnVisibility: .constant(.detailOnly)) {
            EmptyView()
                .toolbar(removing: .sidebarToggle)
        } detail: {
            ReaderDetailView(model: model)
                .readerChrome(model: model)
        }
        .toolbar(removing: .sidebarToggle)
        .readerInspector(model: model)
        .frame(minWidth: 500, minHeight: 530)
    }
}

private struct ReaderChrome: ViewModifier {
    @Bindable var model: ReaderModel

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    ReadingSettingsMenu(model: model)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        withAnimation { model.showInspector.toggle() }
                    } label: {
                        Label("Inspector", systemImage: "sidebar.trailing")
                    }
                    .help(model.showInspector ? "Hide Inspector" : "Show Inspector")
                }
            }
            .navigationTitle(model.title.isEmpty ? "Gull" : model.title)
            .navigationSubtitle(model.currentTocTitle ?? "")
    }
}

/// Attached to the split view itself (not its detail column) so the inspector
/// runs the full height of the window, under the toolbar, like the sidebar.
private struct ReaderInspector: ViewModifier {
    @Bindable var model: ReaderModel

    func body(content: Content) -> some View {
        content.inspector(isPresented: $model.showInspector) {
            InspectorView(model: model)
                .inspectorColumnWidth(min: 240, ideal: 290, max: 480)
        }
    }
}

extension View {
    func readerChrome(model: ReaderModel) -> some View { modifier(ReaderChrome(model: model)) }
    func readerInspector(model: ReaderModel) -> some View { modifier(ReaderInspector(model: model)) }
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
