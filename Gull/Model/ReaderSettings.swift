import AppKit
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

/// Whether the app follows the system's light/dark setting or forces one.
nonisolated enum AppearanceMode: String, CaseIterable, Identifiable, Sendable {
    case auto, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: "Auto"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// The colors of the reading surface. Each appearance (light, dark) has its own set.
nonisolated struct ReaderTheme: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let isDark: Bool
    let background: String
    let text: String
    let secondary: String
    let accent: String
    let border: String

    static let light: [ReaderTheme] = [
        .init(id: "paper", name: "Paper", isDark: false, background: "#ffffff", text: "#171717",
              secondary: "#717171", accent: "#007aff", border: "#d5d5d5"),
        .init(id: "ivory", name: "Ivory", isDark: false, background: "#fbf8f1", text: "#262421",
              secondary: "#7a756c", accent: "#2f6fd0", border: "#e2dccf"),
        .init(id: "sepia", name: "Sepia", isDark: false, background: "#f3e9d6", text: "#4a3a2a",
              secondary: "#8a7560", accent: "#a0522d", border: "#dccbb0"),
        .init(id: "sage", name: "Sage", isDark: false, background: "#e6eee2", text: "#24322a",
              secondary: "#66766a", accent: "#2f7a55", border: "#c9d6c3"),
        .init(id: "mist", name: "Mist", isDark: false, background: "#e8edf4", text: "#1d2733",
              secondary: "#66717f", accent: "#2f6fd0", border: "#ccd5e1"),
        .init(id: "stone", name: "Stone", isDark: false, background: "#ebebea", text: "#232323",
              secondary: "#727272", accent: "#4a6fa5", border: "#d2d2d0"),
    ]

    static let dark: [ReaderTheme] = [
        .init(id: "night", name: "Night", isDark: true, background: "#1e1e1e", text: "#cecdc3",
              secondary: "#888888", accent: "#4aa3ff", border: "#3c3c3c"),
        .init(id: "black", name: "Black", isDark: true, background: "#000000", text: "#c4c4c4",
              secondary: "#7a7a7a", accent: "#4aa3ff", border: "#2a2a2a"),
        .init(id: "graphite", name: "Graphite", isDark: true, background: "#2b2c2f", text: "#dadada",
              secondary: "#8e8f93", accent: "#6cb2ff", border: "#44464a"),
        .init(id: "midnight", name: "Midnight", isDark: true, background: "#161c27", text: "#c7d0dc",
              secondary: "#7b8698", accent: "#6ea8ff", border: "#2c3546"),
        .init(id: "forest", name: "Forest", isDark: true, background: "#18211c", text: "#c6d2c4",
              secondary: "#7f8f82", accent: "#7cc49a", border: "#2c3a31"),
        .init(id: "mocha", name: "Mocha", isDark: true, background: "#262019", text: "#dccbb2",
              secondary: "#9a8a74", accent: "#e0a066", border: "#3e3528"),
    ]
}

/// The reading-style values the reflowable reader applies as CSS variables.
nonisolated struct ReadingStyle: Equatable, Sendable {
    var font: ReadingFont
    var fontSize: Double
    var lineHeight: Double
    var paraSpacing: Double
    var fullWidth: Bool
    var paginated: Bool
    var theme: ReaderTheme
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
    /// Reflowable books show as two-page spreads, turned with the arrow keys, instead of scrolling.
    var paginated: Bool { didSet { defaults.set(paginated, forKey: "paginated") } }
    var chapterScrollbar: Bool { didSet { defaults.set(chapterScrollbar, forKey: "chapterScrollbar") } }
    var pdfZoom: PDFZoom { didSet { defaults.set(pdfZoom.storageValue, forKey: "pdfZoom") } }
    var appearance: AppearanceMode {
        didSet { defaults.set(appearance.rawValue, forKey: "appearance"); applyAppearance() }
    }
    var lightThemeId: String { didSet { defaults.set(lightThemeId, forKey: "lightTheme") } }
    var darkThemeId: String { didSet { defaults.set(darkThemeId, forKey: "darkTheme") } }

    private init() {
        defaults.register(defaults: [
            "font": ReadingFont.charter.rawValue, "fontSize": 16.0, "lineHeight": 1.8, "paraSpacing": 0.6,
            "fullWidth": false, "paginated": false, "chapterScrollbar": true, "pdfZoom": "fit-width",
            "appearance": AppearanceMode.auto.rawValue, "lightTheme": "paper", "darkTheme": "night",
        ])
        font = ReadingFont(rawValue: defaults.string(forKey: "font") ?? "") ?? .charter
        fontSize = Self.nearest(Self.fontSizes, defaults.double(forKey: "fontSize"))
        lineHeight = Self.nearest(Self.lineHeights, defaults.double(forKey: "lineHeight"))
        paraSpacing = Self.nearest(Self.paragraphSpacings, defaults.double(forKey: "paraSpacing"))
        fullWidth = defaults.bool(forKey: "fullWidth")
        paginated = defaults.bool(forKey: "paginated")
        chapterScrollbar = defaults.bool(forKey: "chapterScrollbar")
        pdfZoom = PDFZoom(storageValue: defaults.string(forKey: "pdfZoom"))
        appearance = AppearanceMode(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .auto
        lightThemeId = defaults.string(forKey: "lightTheme") ?? "paper"
        darkThemeId = defaults.string(forKey: "darkTheme") ?? "night"
    }

    /// Forces the app light or dark, or lets it follow the system (Auto).
    func applyAppearance() {
        switch appearance {
        case .auto: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }

    /// The chosen theme for a light or dark appearance.
    func theme(dark: Bool) -> ReaderTheme {
        let themes = dark ? ReaderTheme.dark : ReaderTheme.light
        let id = dark ? darkThemeId : lightThemeId
        return themes.first { $0.id == id } ?? themes[0]
    }

    /// The theme for the app's current effective appearance.
    var currentTheme: ReaderTheme {
        theme(dark: NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
    }

    static func nearest(_ options: [ReadingOption<Double>], _ value: Double) -> Double {
        options.min { abs($0.value - value) < abs($1.value - value) }?.value ?? options[0].value
    }

    func style(theme: ReaderTheme) -> ReadingStyle {
        ReadingStyle(font: font, fontSize: fontSize, lineHeight: lineHeight, paraSpacing: paraSpacing,
                     fullWidth: fullWidth, paginated: paginated, theme: theme)
    }

    /// Steps the font size through the menu's sizes (⌘+ / ⌘−).
    func stepFontSize(_ direction: Int) {
        let values = Self.fontSizes.map(\.value)
        guard let index = values.firstIndex(of: fontSize) else { return }
        fontSize = values[max(0, min(values.count - 1, index + direction))]
    }
}
