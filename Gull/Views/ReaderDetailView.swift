import AppKit
import PDFKit
import SwiftUI
import WebKit

/// The reading area: the book surface, the chapter scrollbar beside it, and
/// the selection popup / footnote popover floating over it.
struct ReaderDetailView: View {
    @Bindable var model: ReaderModel
    @Bindable private var settings = ReaderSettings.shared

    private struct SettingsKey: Equatable {
        var style: ReadingStyle
        var chapterScrollbar: Bool
        var zoom: PDFZoom
    }

    private var settingsKey: SettingsKey {
        SettingsKey(style: settings.style, chapterScrollbar: settings.chapterScrollbar, zoom: settings.pdfZoom)
    }

    var body: some View {
        HStack(spacing: 0) {
            surface
                .overlay { SelectionPopupOverlay(model: model) }
                .overlay { FootnoteOverlay(model: model) }
            if settings.chapterScrollbar, model.hasBook, !model.scrollMap.segments.isEmpty {
                ChapterScrollbar(map: model.scrollMap) { model.scrollTo(offset: $0) }
                    .padding(.vertical, 12)
                    .padding(.trailing, 8)
                    .padding(.leading, 2)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onChange(of: settingsKey, initial: true) { model.applySettings(settings) }
    }

    @ViewBuilder private var surface: some View {
        switch model.phase {
        case .empty:
            Placeholder {
                Message(title: "No Book Open", systemImage: "book.closed",
                        description: model.isStandalone
                            ? "This book is no longer available."
                            : "Choose a book from the sidebar, or open one with ⌘O.")
            }
        case .loading:
            Placeholder { ProgressView().controlSize(.small) }
        case .reflowable:
            HostedNSView(view: model.web.webView)
        case .pdf:
            HostedNSView(view: model.pdf.pdfView)
        case .failed(let message):
            Placeholder {
                Message(title: "Couldn’t Open Book", systemImage: "exclamationmark.triangle", description: message)
            }
        }
    }
}

/// What fills the reader instead of a book. Over plain content the toolbar
/// draws a separator line, so it sits in a scroll view whose top edge effect
/// is hidden.
private struct Placeholder<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        // Sized from the proxy: `containerRelativeFrame` left the scroll view
        // at a default 500pt wide, with its own edge line above it.
        GeometryReader { proxy in
            ScrollView {
                content.frame(width: proxy.size.width, height: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollEdgeEffectHidden(true, for: .top)
        }
    }
}

/// Laid out like `ContentUnavailableView`, which scrolls internally and so
/// brings its own edge line back.
private struct Message: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 40))
                .padding(.bottom, 10)
            Text(title).font(.title3.bold())
            Text(description)
        }
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 440)
    }
}

/// Hosts an AppKit view the reader controllers own and keep across renders.
struct HostedNSView: NSViewRepresentable {
    let view: NSView

    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

// MARK: - Selection popup

private struct SelectionPopupOverlay: View {
    @Bindable var model: ReaderModel
    private let height: CGFloat = 36

    var body: some View {
        GeometryReader { proxy in
            if let selection = model.selection {
                let above = selection.rect.minY - height / 2 - 10
                let y = above < height / 2 + 4 ? selection.rect.maxY + height / 2 + 10 : above
                let x = min(max(selection.rect.midX, 90), proxy.size.width - 90)
                Button {
                    model.popupAction()
                } label: {
                    Label(selection.existingId == nil ? "Highlight" : "Remove Highlight",
                          systemImage: selection.existingId == nil ? "highlighter" : "eraser")
                        .font(.system(size: 13, weight: .medium))
                        .padding(.horizontal, 4)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .fixedSize()
                .position(x: x, y: y)
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
                .keyboardShortcut(.return, modifiers: [])
            }
        }
        .animation(.easeOut(duration: 0.12), value: model.selection?.existingId)
        .animation(.easeOut(duration: 0.12), value: model.selection == nil)
    }
}

// MARK: - Footnote popover

private struct FootnoteOverlay: View {
    @Bindable var model: ReaderModel

    var body: some View {
        GeometryReader { _ in
            if let footnote = model.footnote {
                Color.clear
                    .frame(width: max(footnote.rect.width, 1), height: max(footnote.rect.height, 1))
                    .position(x: footnote.rect.midX, y: footnote.rect.midY)
                    .popover(isPresented: Binding(
                        get: { model.footnote?.id == footnote.id },
                        set: { if !$0 { model.footnote = nil } }
                    ), arrowEdge: .top) {
                        ScrollView {
                            Text(footnote.text)
                                .font(.system(size: 13))
                                .lineSpacing(3)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                        }
                        .frame(width: 360)
                        .frame(maxHeight: 320)
                        .fixedSize(horizontal: false, vertical: true)
                    }
            }
        }
        .allowsHitTesting(model.footnote != nil)
    }
}

// MARK: - Chapter scrollbar

/// The segmented scrollbar that maps the whole book: one segment per TOC
/// entry, sized by how much text it spans and filled as it is read. Click or
/// drag to jump; hover to see the chapter name.
struct ChapterScrollbar: View {
    let map: ScrollMap
    let onJump: (Double) -> Void

    @State private var hover: (title: String, y: CGFloat)?

    private struct Bar {
        var y: CGFloat
        var height: CGFloat
        var fill: CGFloat
        var top: Double
        var span: Double
        var title: String
    }

    private static let minSegment: CGFloat = 2

    private func layout(height: CGFloat) -> [Bar] {
        let count = map.segments.count
        guard count > 0, map.total > 0 else { return [] }
        var gap: CGFloat = 3
        if CGFloat(count) * 6 + CGFloat(count) * gap > height { gap = 1 }
        if CGFloat(count) * 3 + CGFloat(count) * gap > height { gap = 0 }
        let available = max(1, height - CGFloat(count - 1) * gap)

        let spans: [Double] = map.segments.indices.map { index in
            let end = index + 1 < count ? map.segments[index + 1].top : map.total
            return max(1e-6, end - map.segments[index].top)
        }
        let total = spans.reduce(0, +)
        var heights = spans.map { CGFloat($0 / total) * available }
        var deficit: CGFloat = 0
        var flexible: CGFloat = 0
        for index in heights.indices {
            if heights[index] < Self.minSegment {
                deficit += Self.minSegment - heights[index]
                heights[index] = Self.minSegment
            } else {
                flexible += heights[index]
            }
        }
        if deficit > 0, flexible > 0 {
            let scale = max(0, (flexible - deficit) / flexible)
            for index in heights.indices where heights[index] > Self.minSegment { heights[index] *= scale }
        }

        let viewportEnd = map.viewportTop + map.viewportHeight
        var y: CGFloat = 0
        return map.segments.indices.map { index in
            let segment = map.segments[index]
            let span = spans[index]
            var ratio = 0.0
            if viewportEnd >= segment.top + span { ratio = 1 } else if viewportEnd > segment.top { ratio = (viewportEnd - segment.top) / span }
            let bar = Bar(y: y, height: heights[index], fill: CGFloat(max(0, min(1, ratio))) * heights[index],
                          top: segment.top, span: span, title: segment.title)
            y += heights[index] + gap
            return bar
        }
    }

    private func bar(at y: CGFloat, in bars: [Bar]) -> Bar? {
        bars.first { y >= $0.y && y < $0.y + $0.height + 3 } ?? (y < 0 ? bars.first : bars.last)
    }

    var body: some View {
        GeometryReader { proxy in
            let bars = layout(height: proxy.size.height)
            Canvas { context, size in
                let track = Color.primary.opacity(0.13)
                for bar in bars {
                    let rect = CGRect(x: 0, y: bar.y, width: size.width, height: bar.height)
                    context.fill(Path(roundedRect: rect, cornerRadius: min(2, bar.height / 2)), with: .color(track))
                    if bar.fill > 0 {
                        let fill = CGRect(x: 0, y: bar.y, width: size.width, height: bar.fill)
                        context.fill(Path(roundedRect: fill, cornerRadius: min(2, bar.height / 2)), with: .color(.accentColor))
                    }
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                guard let target = bar(at: value.location.y, in: bars) else { return }
                let within = max(0, min(1, Double((value.location.y - target.y) / max(target.height, 1))))
                onJump(target.top + target.span * within)
            })
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    if let target = bar(at: location.y, in: bars), !target.title.isEmpty {
                        hover = (target.title, location.y)
                    } else {
                        hover = nil
                    }
                case .ended:
                    hover = nil
                }
            }
            .overlay(alignment: .topTrailing) {
                if let hover {
                    Text(hover.title)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .glassEffect(.regular, in: .rect(cornerRadius: 6))
                        .fixedSize()
                        .offset(x: -16, y: hover.y - 12)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(width: 8)
        .accessibilityElement()
        .accessibilityLabel("Chapter scrollbar")
        .accessibilityValue(Text("\(Int(min(1, (map.viewportTop + map.viewportHeight) / max(map.total, 1)) * 100)) percent"))
    }
}
