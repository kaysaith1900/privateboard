import SwiftUI
import UIKit

/// Circular avatar. The server stores a director's portrait in `avatarPath` as
/// a **`data:` URL** (a snapshot of their 3D avatar rendered by Avatar3DSnap),
/// so we decode that inline; http(s)/relative paths load via AsyncImage; and a
/// gold monogram initial is the fallback (matches the web `avatarThumb`).
struct AvatarView: View {
    @Environment(AppState.self) private var app
    let path: String?
    let name: String
    var size: CGFloat = 44

    @State private var localImage: UIImage?   // data: URI OR bundled static file · both load WITHOUT the loopback

    private var remoteURL: URL? {
        guard let p = path, !p.isEmpty, !p.hasPrefix("data:") else { return nil }
        // Bundled asset (e.g. /avatars/3d/*.png) → loaded straight from disk in
        // `.task` (localImage), so it never touches the loopback socket and can't
        // blank when iOS reclaims it on suspend. Only genuinely non-bundled paths
        // fall through to the HTTP fetch below.
        if Self.bundledFileURL(p) != nil { return nil }
        guard let base = app.api?.assetURL(p) else { return nil }
        // Fold the foreground-recovery token into the URL so AsyncImage re-fetches
        // after the loopback socket is revived (even on the same port). Reading the
        // token here also makes this view re-render when it bumps.
        let token = app.assetReloadToken
        guard token > 0, var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "_r", value: String(token))]
        return comps.url ?? base
    }

    var body: some View {
        Group {
            if let localImage {
                Image(uiImage: localImage).resizable().scaledToFill()
            } else if let url = remoteURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                    else { monogram }
                }
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        // Border scales with the circle so a large avatar (e.g. the 96pt My Avatar
        // screen) keeps the SAME border-to-diameter ratio as the list thumbnails
        // (1pt at the 44pt default), instead of a hairline that reads too thin.
        .overlay(Circle().strokeBorder(Color.bbLine, lineWidth: max(1, size / 44)))
        .task(id: path) { localImage = Self.loadLocal(path) }
    }

    private var monogram: some View {
        ZStack {
            Color.bbSurfaceHi
            Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(Color.bbGold)
        }
    }

    /// Load the portrait WITHOUT the loopback when possible · an inline `data:` URI
    /// or a bundled static asset (e.g. `/avatars/3d/*.png`, which the loopback would
    /// otherwise just read from the same bundle over HTTP). Returns nil for genuinely
    /// remote paths, which fall back to `AsyncImage`/loopback.
    static func loadLocal(_ s: String?) -> UIImage? {
        if let img = decodeDataURL(s) { return img }
        if let s, let f = bundledFileURL(s) { return UIImage(contentsOfFile: f.path) }
        return nil
    }

    /// The bundle URL of a web-relative asset path (`/avatars/…`) if it exists in the
    /// shipped `web/` tree — the same root the loopback serves. nil for `data:`,
    /// `http(s)`, or paths not present in the bundle.
    private static let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true)
    static func bundledFileURL(_ path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let root = webRoot else { return nil }
        let rel = String(path.drop(while: { $0 == "/" }))
        guard !rel.isEmpty, !rel.contains("..") else { return nil }
        let url = root.appendingPathComponent(rel)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Decode a `data:[mime];base64,<payload>` URL into a UIImage (nil otherwise).
    static func decodeDataURL(_ s: String?) -> UIImage? {
        guard let s, s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") else { return nil }
        let header = s[s.startIndex..<comma]
        guard header.contains("base64") else { return nil }
        let payload = String(s[s.index(after: comma)...])
        guard let data = Data(base64Encoded: payload) else { return nil }
        return UIImage(data: data)
    }
}
