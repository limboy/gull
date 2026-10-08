import AppKit
import SwiftUI

/// The library: pinned books, then each folder added from disk as a
/// collapsible tree mirroring the directories, then any loose rows.
struct LibrarySidebar: View {
    @Bindable private var library = LibraryStore.shared
    @State private var isDropTarget = false

    var body: some View {
        let sections = library.sections
        List(selection: $library.activePath) {
            if !sections.pinned.isEmpty {
                Section("Pinned") {
                    ForEach(sections.pinned) { BookRow(book: $0) }
                }
            }
            ForEach(sections.folders) { folder in
                Section(isExpanded: Binding(
                    get: { !folder.collapsed },
                    set: { library.setCollapsed(folder.path, !$0) }
                )) {
                    FolderItems(items: folder.items)
                } header: {
                    FolderLabel(section: folder)
                }
            }
            if !sections.unfiled.isEmpty {
                Section("Books") {
                    ForEach(sections.unfiled) { BookRow(book: $0) }
                }
            }
        }
        .listStyle(.sidebar)
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
        .overlay {
            if isDropTarget {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.08)))
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            guard !folders.isEmpty else { return false }
            Task { await library.addFolders(folders) }
            return true
        } isTargeted: { isDropTarget = $0 }
        .toolbar {
            ToolbarItemGroup {
                SortMenu()
                Button {
                    library.addFolderFromPanel(window: NSApp.keyWindow)
                } label: {
                    Label("Add Book Folder", systemImage: "folder.badge.plus")
                }
                .help("Add Book Folder")
            }
        }
    }
}

/// Folder contents: books and subfolders interleaved in the chosen order.
/// Books are inset so they sit under the folder rather than flush with it.
private struct FolderItems: View {
    let items: [SidebarEntry]
    private let inset: CGFloat = 12

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
        }
    }
}

private struct FolderLabel: View {
    let section: SidebarFolderSection
    private var library: LibraryStore { .shared }

    var body: some View {
        Label(section.title, systemImage: section.collapsed ? "folder" : "folder")
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
            Label("Sort", systemImage: "arrow.up.arrow.down")
        }
        .help("Sort Books")
    }
}
