import AppKit
import SwiftUI

/// Gull › Settings: the app's appearance (Auto, Light, Dark) and the reading
/// theme used for each. There is one of it, and it is never restored at launch.
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    private init() {
        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered, defer: true
        )
        window.title = "Settings"
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.contentViewController = NSHostingController(rootView: SettingsView())
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    @objc func show(_ sender: Any?) {
        guard let window else { return }
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
    }
}

private struct SettingsView: View {
    @Bindable private var settings = ReaderSettings.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            section("Appearance") {
                Picker("Appearance", selection: $settings.appearance) {
                    ForEach(AppearanceMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            section("Light Theme") {
                ThemeRow(themes: ReaderTheme.light, selection: $settings.lightThemeId)
            }
            section("Dark Theme") {
                ThemeRow(themes: ReaderTheme.dark, selection: $settings.darkThemeId)
            }
        }
        .padding(24)
        .fixedSize()
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
    }
}

/// The six themes for one appearance, as swatches showing their page and text colors.
private struct ThemeRow: View {
    let themes: [ReaderTheme]
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 14) {
            ForEach(themes) { theme in
                ThemeSwatch(theme: theme, isSelected: theme.id == selection) { selection = theme.id }
            }
        }
    }
}

private struct ThemeSwatch: View {
    let theme: ReaderTheme
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color(hex: theme.background))
                    .frame(width: 68, height: 50)
                    .overlay {
                        Text("Aa")
                            .font(.custom("Charter", size: 20))
                            .foregroundStyle(Color(hex: theme.text))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(isSelected ? Color.accentColor : Color(nsColor: .separatorColor),
                                          lineWidth: isSelected ? 2.5 : 1)
                    }
                Text(theme.name)
                    .font(.caption)
                    .foregroundStyle(isSelected ? .primary : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(theme.name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

extension Color {
    /// A color from a `#rrggbb` string, as the reader themes are written.
    init(hex: String) {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255,
                  blue: Double(value & 0xff) / 255)
    }
}
