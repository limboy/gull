import SwiftUI

/// The right-hand panel: table of contents, highlights, and search.
struct InspectorView: View {
    @Bindable var model: ReaderModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("Panel", selection: $model.inspectorMode) {
                ForEach(InspectorMode.allCases) { mode in
                    Image(systemName: mode.symbol)
                        .help(mode.title)
                        .accessibilityLabel(mode.title)
                        .tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            switch model.inspectorMode {
            case .toc: TocPanel(model: model)
            case .highlights: HighlightsPanel(model: model)
            case .search: SearchPanel(model: model)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// A gentle placeholder for empty panels.
private struct PanelMessage: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 40)
        Spacer(minLength: 0)
    }
}

// MARK: - Contents

private struct TocPanel: View {
    @Bindable var model: ReaderModel
    @State private var isHovering = false

    var body: some View {
        if !model.hasBook {
            PanelMessage(text: "Open a book to see its contents.")
        } else if model.toc.isEmpty {
            PanelMessage(text: "This book has no table of contents.")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(model.toc) { item in
                            TocRow(item: item, isActive: item.id == model.activeTocIndex) { model.goToToc(item) }
                                .id(item.id)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 16)
                }
                .scrollIndicators(.automatic)
                .onHover { isHovering = $0 }
                .onChange(of: model.activeTocIndex, initial: true) { _, active in
                    // Follow the reader, but never yank the list from under the pointer.
                    guard let active, !isHovering else { return }
                    proxy.scrollTo(active, anchor: .center)
                }
            }
        }
    }
}

private struct TocRow: View {
    let item: FlatTocItem
    let isActive: Bool
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Text(item.title)
                .font(.system(size: 13, weight: item.level == 1 ? .regular : .regular))
                .foregroundStyle(isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(item.level == 1 ? .primary : .secondary))
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, CGFloat(item.level - 1) * 14 + 8)
                .padding(.trailing, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isActive ? Color.accentColor.opacity(0.12) : hovered ? Color.primary.opacity(0.06) : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

// MARK: - Highlights

private struct HighlightsPanel: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let highlights = model.highlights
        if !model.hasBook {
            PanelMessage(text: "Open a book to see highlights.")
        } else if highlights.isEmpty {
            PanelMessage(text: "No highlights yet. Select text to highlight it.")
        } else {
            List {
                ForEach(highlights) { highlight in
                    HighlightRow(highlight: highlight,
                                 open: { model.openHighlight(highlight) },
                                 delete: { model.removeHighlight(highlight.id) })
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
        }
    }
}

private struct HighlightRow: View {
    let highlight: Highlight
    let open: () -> Void
    let delete: () -> Void
    @State private var hovered = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 8) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.yellow.opacity(0.8))
                        .frame(width: 3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(highlight.text)
                            .font(.system(size: 13))
                            .lineLimit(4)
                            .multilineTextAlignment(.leading)
                        Text(Date(timeIntervalSince1970: highlight.createdAt / 1000), format: .dateTime.month().day().year().hour().minute())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: delete) {
                Image(systemName: "trash")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .opacity(hovered ? 1 : 0)
            .help("Delete Highlight")
            .accessibilityLabel("Delete highlight")
        }
        .padding(.vertical, 4)
        .onHover { hovered = $0 }
        .contextMenu {
            Button("Go to Highlight", action: open)
            Button("Copy Text") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(highlight.text, forType: .string)
            }
            Divider()
            Button("Delete Highlight", role: .destructive, action: delete)
        }
    }
}

// MARK: - Search

private struct SearchPanel: View {
    @Bindable var model: ReaderModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search in Book", text: $model.searchQuery)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .onSubmit { if let first = model.searchResults.first { model.openSearchResult(first) } }
                    .onKeyPress(.escape) {
                        model.searchQuery = ""
                        return .handled
                    }
                if !model.searchQuery.isEmpty {
                    Button {
                        model.searchQuery = ""
                        focused = true
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            if let status = model.searchStatus {
                PanelMessage(text: status)
            } else {
                let terms = SearchIndex.terms(for: model.searchQuery)
                List(model.searchResults) { result in
                    Button { model.openSearchResult(result) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            if !result.title.isEmpty {
                                Text(result.title)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Text(Self.highlighted(result.snippet, terms: terms))
                                .font(.system(size: 13))
                                .lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
            }
        }
        .onAppear { focused = true }
        .onChange(of: model.searchFocusRequest) { focused = true }
    }

    static func highlighted(_ snippet: String, terms: [String]) -> AttributedString {
        var attributed = AttributedString(snippet)
        let lower = snippet.lowercased()
        for term in terms where !term.isEmpty {
            var from = lower.startIndex
            while let range = lower.range(of: term, range: from..<lower.endIndex) {
                let start = lower.distance(from: lower.startIndex, to: range.lowerBound)
                let length = lower.distance(from: range.lowerBound, to: range.upperBound)
                let chars = attributed.characters
                if start + length <= chars.count {
                    let lowerBound = chars.index(chars.startIndex, offsetBy: start)
                    let upperBound = chars.index(lowerBound, offsetBy: length)
                    attributed[lowerBound..<upperBound].backgroundColor = Color.yellow.opacity(0.45)
                    attributed[lowerBound..<upperBound].font = .system(size: 13, weight: .semibold)
                }
                from = range.upperBound
            }
        }
        return attributed
    }
}
