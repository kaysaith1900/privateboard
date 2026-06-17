import Foundation

/// Runtime toggle for the on-device native engine. OFF (default) → the app talks
/// to the desktop/cloud server via `APIClient` exactly as before (always
/// shippable). ON → rooms run entirely in-process via `BoardroomEngine`, no
/// server. Surfaced as a hidden switch in Settings; backed by UserDefaults so it
/// survives launches.
enum FeatureFlag {
    private static let nativeEngineKey = "boardroom.feature.nativeEngine"

    static var nativeEngine: Bool {
        get { UserDefaults.standard.bool(forKey: nativeEngineKey) }
        set { UserDefaults.standard.set(newValue, forKey: nativeEngineKey) }
    }
}
