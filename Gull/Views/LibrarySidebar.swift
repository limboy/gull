import AppKit
import SwiftUI

/// The library: pinned books, then each folder added from disk as a
/// collapsible tree mirroring the directories, then any loose rows.
struct LibrarySidebar: View {
    @Bindable private var library = LibraryStore.shared
    @State private var filter = ""

    var body: some View {
        let sections = library.sections(filter: filter)
        List(selection: $library.activePath) {
            if !sections.pinned.isEmpty {
                Section("Pinned") {
                    ForEach(sections.pinned) { BookRow(book: $0) }
                }
            }
            // Folders are plain disclosure rows rather than sections, so their
            // titles read like rows and they stack without section spacing.
            // They share one section with loose books so rows never spill into
            // the Pinned section.
            if !sections.folders.isEmpty || !sections.unfiled.isEmpty {
                Section("Books") {
                    ForEach(sections.folders) { SubfolderRow(section: $0) }
                    ForEach(sections.unfiled) { BookRow(book: $0) }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) { SidebarBottomBar(filter: $filter) }
        .overlay {
            if library.folders.isEmpty, library.books.isEmpty {
                ContentUnavailableView {
                    Label("No Book Folders", systemImage: "books.vertical")
                } description: {
                    Text("Add a folder of EPUB, Kindle, or PDF books, or drag one here from Finder.")
                } actions: {
                    Button("Add Book Folder…") { library.addFolderFromPanel(window: NSApp.keyWindow) }
                }
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            guard !folders.isEmpty else { return false }
            Task { await library.addFolders(folders) }
            return true
        }
    }
}

/// Folder contents: books and subfolders interleaved in the chosen order.
/// Books are inset so they sit under the folder rather than flush with it.
private struct FolderItems: View {
    let items: [SidebarEntry]
    private let inset: CGFloat = 4

    var body: some View {
        if items.isEmpty {
            Text("No books in this folder")
                .font(.callout)
                .foregroundStyle(.secondary)
                .selectionDisabled()
                .padding(.leading, inset)
        }
        ForEach(items) { entry in
            switch entry {
            case .book(let book):
                BookRow(book: book)
                    .padding(.leading, inset)
            case .folder(let section):
                SubfolderRow(section: section)
            }
        }
    }
}

private struct SubfolderRow: View {
    let section: SidebarFolderSection
    @Bindable private var library = LibraryStore.shared

    var body: some View {
        DisclosureGroup(isExpanded: Binding(
            get: { !section.collapsed },
            set: { library.setCollapsed(section.path, !$0) }
        )) {
            // Recursion through a type-erased view keeps the opaque types finite.
            AnyView(FolderItems(items: section.items))
        } label: {
            FolderLabel(section: section)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                // Simultaneous, so a single click still selects the row at once.
                .simultaneousGesture(TapGesture(count: 2).onEnded {
                    withAnimation { library.setCollapsed(section.path, !section.collapsed) }
                })
        }
    }
}

private struct FolderLabel: View {
    let section: SidebarFolderSection
    private var library: LibraryStore { .shared }

    var body: some View {
        Label {
            Text(section.title)
        } icon: {
            // SF Symbols has no open folder; `folder.open` is a custom symbol
            // drawn to match `folder`. Both stay laid out, so the icon keeps
            // one size as the folder opens and closes.
            ZStack {
                Image(systemName: "folder").opacity(section.collapsed ? 1 : 0)
                Image("folder.open").opacity(section.collapsed ? 0 : 1)
            }
        }
            .lineLimit(1)
            .contextMenu {
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: section.path)])
                }
                Divider()
                Button("Expand All") { library.setTreeCollapsed(section.path, false) }
                Button("Collapse All") { library.setTreeCollapsed(section.path, true) }
                if section.depth == 0 {
                    Divider()
                    Button("Remove from Sidebar") { library.removeFolder(section.path) }
                }
            }
    }
}

struct BookRow: View {
    let book: LibraryBook
    private var library: LibraryStore { .shared }

    var body: some View {
        HStack(spacing: 8) {
            CoverThumbnail(path: book.filePath)
            Text(book.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if book.finished {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Finished")
            }
        }
        .tag(book.filePath)
        .contextMenu {
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([book.url]) }
            Button("Open in New Window") { AppDelegate.shared.openBook(book.url) }
            Divider()
            Toggle("Pin", isOn: Binding(get: { book.pinned }, set: { _ in library.togglePin(book.filePath) }))
            Toggle("Mark as Finished", isOn: Binding(get: { book.finished }, set: { _ in library.toggleFinished(book.filePath) }))
        }
    }
}

/// Real cover art, loaded lazily as rows scroll into view.
struct CoverThumbnail: View {
    let path: String
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 15, height: 21)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                    .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
            } else {
                Image(systemName: path.lowercased().hasSuffix(".pdf") ? "doc.richtext" : "book.closed")
                    .foregroundStyle(.secondary)
                    .frame(width: 15, height: 21)
            }
        }
        .task(id: path) { image = await CoverService.shared.cover(for: path) }
    }
}

/// The bar pinned to the bottom of the sidebar: add a folder, the sort
/// menu, and a filter field matching book file names. Living in the sidebar,
/// it collapses along with it.
private struct SidebarBottomBar: View {
    @Binding var filter: String
    private var library: LibraryStore { .shared }
    /// Shared by the round buttons and the filter capsule so they line up.
    static let controlHeight: CGFloat = 32

    var body: some View {
        HStack(spacing: 8) {
            Button {
                library.addFolderFromPanel(window: NSApp.keyWindow)
            } label: {
                Image(systemName: "folder.badge.plus")
                    .frame(width: Self.controlHeight, height: Self.controlHeight)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .help("Add Book Folder")

            SortMenu()

            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal.decrease")
                    .foregroundStyle(.secondary)
                TextField("Filter", text: $filter)
                    .textFieldStyle(.plain)
                if !filter.isEmpty {
                    Button {
                        filter = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Clear Filter")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: Self.controlHeight)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

private struct SortMenu: View {
    @Bindable private var library = LibraryStore.shared

    var body: some View {
        Menu {
            Picker("Sort By", selection: $library.sort.key) {
                Text("Name").tag(SortOptions.Key.name)
                Text("Date Created").tag(SortOptions.Key.created)
            }
            .pickerStyle(.inline)
            Picker("Order", selection: $library.sort.direction) {
                Text("Ascending").tag(SortOptions.Direction.asc)
                Text("Descending").tag(SortOptions.Direction.desc)
            }
            .pickerStyle(.inline)
            Divider()
            Toggle("Folders First", isOn: $library.sort.foldersFirst)
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .frame(width: SidebarBottomBar.controlHeight, height: SidebarBottomBar.controlHeight)
                .contentShape(.circle)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .glassEffect(.regular.interactive(), in: .circle)
        .help("Sort Books")
    }
}
