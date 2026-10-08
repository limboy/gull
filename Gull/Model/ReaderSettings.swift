import Foundation
import Observation

nonisolated enum ReadingFont: String, CaseIterable, Identifiable, Codable, Sendable {
    case inter, charter, monospace, systemSans, openSans

    var id: String { rawValue }

    var label: String {
        switch self {
        case .inter: "Inter"
        case .charter: "Charter"
        case .monospace: "Monospace"
        case .systemSans: "System Sans"
        case .openSans: "Open Sans"
        }
    }

    var cssFamily: String {
        switch self {
        case .inter: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
        case .charter: "'Charter', serif"
        case .monospace: "'Geist Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"
        case .systemSans: "-apple-system, BlinkMacSystemFont, sans-serif"
        case .openSans: "'Open Sans', -apple-system, BlinkMacSystemFont, sans-serif"
        }
    }
}

nonisolated struct ReadingOption<Value: Hashable & Sendable>: Hashable, Sendable {
    let label: String
    let value: Value
}

nonisolated enum PDFZoom: Hashable, Sendable {
    case fitWidth, fitPage, scale(Double)

    static let options: [ReadingOption<PDFZoom>] = [
        .init(label: "Fit Width", value: .fitWidth),
        .init(label: "Fit Page", value: .fitPage),
        .init(label: "100%", value: .scale(1)),
        .init(label: "125%", value: .scale(1.25)),
        .init(label: "150%", value: .scale(1.5)),
        .init(label: "200%", value: .scale(2)),
    ]

    var storageValue: String {
        switch self {
        case .fitWidth: "fit-width"
        case .fitPage: "fit-page"
        case .scale(let value): String(value)
        }
    }

    init(storageValue: String?) {
        switch storageValue {
        case "fit-page": self = .fitPage
        case let value?: self = Double(value).flatMap { (0.1...6).contains($0) ? .scale($0) : nil } ?? .fitWidth
        default: self = .fitWidth
        }
    }
}

/// The reading-style values the reflowable reader applies as CSS variables.
nonisolated struct ReadingStyle: Equatable, Sendable {
    var font: ReadingFont
    var fontSize: Double
    var lineHeight: Double
    var paraSpacing: Double
    var fullWidth: Bool
}

/// Reader preferences shared by every window, persisted in UserDefaults.
@Observable
final class ReaderSettings {
    static let shared = ReaderSettings()

    static let fontSizes: [ReadingOption<Double>] = [
        .init(label: "Small", value: 13), .init(label: "Normal", value: 16),
        .init(label: "Large", value: 19), .init(label: "Extra Large", value: 22),
    ]
    static let lineHeights: [ReadingOption<Double>] = [
        .init(label: "Compact", value: 1.4), .init(label: "Normal", value: 1.8), .init(label: "Relaxed", value: 2.2),
    ]
    static let paragraphSpacings: [ReadingOption<Double>] = [
        .init(label: "Small", value: 0.3), .init(label: "Normal", value: 0.6), .init(label: "Large", value: 1.5),
    ]

    private let defaults = UserDefaults.standard

    var font: ReadingFont { didSet { defaults.set(font.rawValue, forKey: "font") } }
    var fontSize: Double { didSet { defaults.set(fontSize, forKey: "fontSize") } }
    var lineHeight: Double { didSet { defaults.set(lineHeight, forKey: "lineHeight") } }
    var paraSpacing: Double { didSet { defaults.set(paraSpacing, forKey: "paraSpacing") } }
    var fullWidth: Bool { didSet { defaults.set(fullWidth, forKey: "fullWidth") } }
    var chapterScrollbar: Bool { didSet { defaults.set(chapterScrollbar, forKey: "chapterScrollbar") } }
    var pdfZoom: PDFZoom { didSet { defaults.set(pdfZoom.storageValue, forKey: "pdfZoom") } }

    private init() {
        defaults.register(defaults: [
            "font": ReadingFont.charter.rawValue, "fontSize": 16.0, "lineHeight": 1.8, "paraSpacing": 0.6,
            "fullWidth": false, "chapterScrollbar": true, "pdfZoom": "fit-width",
        ])
        font = ReadingFont(rawValue: defaults.string(forKey: "font") ?? "") ?? .charter
        fontSize = Self.nearest(Self.fontSizes, defaults.double(forKey: "fontSize"))
        lineHeight = Self.nearest(Self.lineHeights, defaults.double(forKey: "lineHeight"))
        paraSpacing = Self.nearest(Self.paragraphSpacings, defaults.double(forKey: "paraSpacing"))
        fullWidth = defaults.bool(forKey: "fullWidth")
        chapterScrollbar = defaults.bool(forKey: "chapterScrollbar")
        pdfZoom = PDFZoom(storageValue: defaults.string(forKey: "pdfZoom"))
    }

    static func nearest(_ options: [ReadingOption<Double>], _ value: Double) -> Double {
        options.min { abs($0.value - value) < abs($1.value - value) }?.value ?? options[0].value
    }

    var style: ReadingStyle {
        ReadingStyle(font: font, fontSize: fontSize, lineHeight: lineHeight, paraSpacing: paraSpacing, fullWidth: fullWidth)
    }

    /// Steps the font size through the menu's sizes (⌘+ / ⌘−).
    func stepFontSize(_ direction: Int) {
        let values = Self.fontSizes.map(\.value)
        guard let index = values.firstIndex(of: fontSize) else { return }
        fontSize = values[max(0, min(values.count - 1, index + direction))]
    }
}
