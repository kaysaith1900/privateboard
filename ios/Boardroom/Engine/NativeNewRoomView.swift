import SwiftUI

/// Minimal native room creator (no server). Collects a subject, seats the seeded
/// directors, and hands back an app `Room` to push into the real `RoomView`
/// (which runs it through `EngineRoomBackend`). The full director-picking
/// `NewRoomView` is server-bound; this is the on-device MVP path.
struct NativeNewRoomView: View {
    var onCreated: (Room) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var subject = ""
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Subject") {
                    TextField("What should the board discuss?", text: $subject, axis: .vertical)
                        .lineLimit(2...6)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                Section {
                    Button(creating ? "Convening…" : "Convene (on-device)") { create() }
                        .disabled(subject.trimmingCharacters(in: .whitespaces).isEmpty || creating)
                } footer: {
                    Text("Runs entirely on this device — no server. Seats your seeded directors.")
                }
            }
            .navigationTitle("New room · native")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func create() {
        guard let host = NativeEngineHost.shared else { error = "Engine unavailable."; return }
        creating = true; error = nil
        let subj = subject.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                let id = try await host.createRoom(subject: subj)
                let snap = try await host.backend.getRoom(id)
                guard let room = snap.room else { throw NSError(domain: "native", code: 1) }
                await MainActor.run { creating = false; onCreated(room) }
            } catch {
                await MainActor.run { creating = false; self.error = "Couldn't create the room: \(error.localizedDescription)" }
            }
        }
    }
}
