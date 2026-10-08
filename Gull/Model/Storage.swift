import Foundation

/// JSON files under `~/Library/Application Support/me.limboy.gull`, written atomically.
nonisolated enum Storage {
    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("me.limboy.gull", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static let cachesDirectory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("me.limboy.gull", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static func load<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func save<T: Encodable>(_ value: T, to name: String) {
        do {
            let data = try JSONEncoder().encode(value)
            try data.write(to: directory.appendingPathComponent(name), options: [.atomic])
        } catch {
            NSLog("Gull: failed to save \(name): \(error)")
        }
    }
}

/// Coalesces bursts of writes (scroll positions, rescans) into one save.
final class DebouncedSaver {
    private var task: Task<Void, Never>?
    private let delay: Duration
    private let action: () -> Void

    init(delay: Duration = .milliseconds(300), action: @escaping () -> Void) {
        self.delay = delay
        self.action = action
    }

    func schedule() {
        task?.cancel()
        task = Task { [weak self] in
            guard let delay = self?.delay else { return }
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.action()
        }
    }

    func flush() {
        guard task != nil else { return }
        task?.cancel()
        task = nil
        action()
    }
}
