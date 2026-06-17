import Foundation

/// Race an async operation against a wall-clock deadline (port of the desktop
/// `withTimeout` / `TimeoutError`). Returns the operation's value, or nil if the
/// timeout won (the operation task is then cancelled). Used to bound the
/// next-speaker picker so a hung utility call falls back to round-robin instead
/// of stalling the room.
func withTimeout<T: Sendable>(seconds: Double, _ operation: @escaping @Sendable () async -> T) async -> T? {
    await withTaskGroup(of: Optional<T>.self) { group in
        group.addTask { await operation() }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return nil
        }
        defer { group.cancelAll() }
        for await first in group { return first }   // whichever child finishes first
        return nil
    }
}
