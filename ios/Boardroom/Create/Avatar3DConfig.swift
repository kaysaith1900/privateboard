import Foundation

/// The 3D-avatar config (捏脸 selection) · 1:1 with the web `Avatar3dConfig`.
/// Every dimension is a style id or a `#rrggbb` colour. Sent live to the editor
/// embed (`setConfig`) and saved alongside the rendered PNG so the avatar stays
/// editable (`avatar3d` on the agent).
struct Avatar3DConfig: Codable, Equatable, Hashable {
    var model: String
    var hairStyle: String
    var topStyle: String
    var bottomStyle: String
    var accessory: String
    var browStyle: String
    var eyeStyle: String
    var beardStyle: String
    var tieStyle: String
    var skin: String
    var hair: String
    var brow: String
    var beard: String
    var top: String
    var bottom: String
    var tie: String
    var eye: String

    /// Ordered (key, label-key) of the style dimensions, for building pickers.
    static let styleDims: [(key: String, label: String)] = [
        ("model", "m_av_model"), ("hairStyle", "m_av_hair"), ("accessory", "m_av_accessory"),
        ("browStyle", "m_av_brow"), ("eyeStyle", "m_av_eye"), ("beardStyle", "m_av_beard"),
        ("tieStyle", "m_av_tie"), ("topStyle", "m_av_top"), ("bottomStyle", "m_av_bottom"),
    ]
    /// Ordered (key, label-key, palette-key) of the colour dimensions.
    static let colorDims: [(key: String, label: String, palette: String)] = [
        ("skin", "m_av_c_skin", "skin"), ("hair", "m_av_c_hair", "hair"), ("brow", "m_av_c_brow", "brow"),
        ("beard", "m_av_c_beard", "beard"), ("top", "m_av_c_top", "top"), ("bottom", "m_av_c_bottom", "bottom"),
        ("tie", "m_av_c_tie", "tie"), ("eye", "m_av_c_eye", "eye"),
    ]

    subscript(key: String) -> String {
        get {
            switch key {
            case "model": return model; case "hairStyle": return hairStyle
            case "topStyle": return topStyle; case "bottomStyle": return bottomStyle
            case "accessory": return accessory; case "browStyle": return browStyle
            case "eyeStyle": return eyeStyle; case "beardStyle": return beardStyle
            case "tieStyle": return tieStyle
            case "skin": return skin; case "hair": return hair; case "brow": return brow
            case "beard": return beard; case "top": return top; case "bottom": return bottom
            case "tie": return tie; case "eye": return eye
            default: return ""
            }
        }
        set {
            switch key {
            case "model": model = newValue; case "hairStyle": hairStyle = newValue
            case "topStyle": topStyle = newValue; case "bottomStyle": bottomStyle = newValue
            case "accessory": accessory = newValue; case "browStyle": browStyle = newValue
            case "eyeStyle": eyeStyle = newValue; case "beardStyle": beardStyle = newValue
            case "tieStyle": tieStyle = newValue
            case "skin": skin = newValue; case "hair": hair = newValue; case "brow": brow = newValue
            case "beard": beard = newValue; case "top": top = newValue; case "bottom": bottom = newValue
            case "tie": tie = newValue; case "eye": eye = newValue
            default: break
            }
        }
    }

    /// Compact JSON object string for `AvatarBridge.setConfig`.
    func jsonString() -> String {
        guard let d = try? JSONEncoder().encode(self), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// `[String: Any]` for the agent PATCH / create body (`avatar3d` field).
    var dictionary: [String: Any] {
        ["model": model, "hairStyle": hairStyle, "topStyle": topStyle, "bottomStyle": bottomStyle,
         "accessory": accessory, "browStyle": browStyle, "eyeStyle": eyeStyle, "beardStyle": beardStyle,
         "tieStyle": tieStyle, "skin": skin, "hair": hair, "brow": brow, "beard": beard,
         "top": top, "bottom": bottom, "tie": tie, "eye": eye]
    }

    /// Tolerant decode · unknown / missing fields default so a partial or legacy
    /// config never fails (mirrors the build's graceful fallbacks).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // `decode` (not decodeIfPresent) → `try?` yields a clean `String?`; a
        // missing / null / mistyped field throws and falls back to the default.
        func s(_ k: CodingKeys, _ d: String) -> String { (try? c.decode(String.self, forKey: k)) ?? d }
        model = s(.model, "casual"); hairStyle = s(.hairStyle, "casual")
        topStyle = s(.topStyle, "casual"); bottomStyle = s(.bottomStyle, "casual")
        accessory = s(.accessory, "none"); browStyle = s(.browStyle, "default")
        eyeStyle = s(.eyeStyle, "default"); beardStyle = s(.beardStyle, "none"); tieStyle = s(.tieStyle, "none")
        skin = s(.skin, "#f1c27d"); hair = s(.hair, "#3a2a1e"); brow = s(.brow, "#3a2a1e"); beard = s(.beard, "#3a2a1e")
        top = s(.top, "#3b5b78"); bottom = s(.bottom, "#556070"); tie = s(.tie, "#3b5b78"); eye = s(.eye, "#241c16")
    }
    init() {
        model = "casual"; hairStyle = "casual"; topStyle = "casual"; bottomStyle = "casual"
        accessory = "none"; browStyle = "default"; eyeStyle = "default"; beardStyle = "none"; tieStyle = "none"
        skin = "#f1c27d"; hair = "#3a2a1e"; brow = "#3a2a1e"; beard = "#3a2a1e"
        top = "#3b5b78"; bottom = "#556070"; tie = "#3b5b78"; eye = "#241c16"
    }

    /// Build from the `[String: Any]` config the avatar embed posts back (the
    /// seed's `deriveDefaultAvatarConfig`) · via the tolerant Codable path so a
    /// missing field just takes its default. Returns nil only if the dict can't be
    /// serialized. Lets the reroll persist the rolled look as `avatar3d`.
    init?(jsonObject: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: jsonObject),
              let decoded = try? JSONDecoder().decode(Avatar3DConfig.self, from: data) else { return nil }
        self = decoded
    }
}

/// Style lists + colour palettes vended by the editor embed (`catalog()`),
/// sourced from `avatar-3d.js` so native pickers never drift from the renderer.
struct AvatarCatalog: Decodable {
    struct Style: Decodable, Hashable, Identifiable { let id: String; let label: String }
    let models: [Style]
    let hairStyles: [Style]
    let topStyles: [Style]
    let bottomStyles: [Style]
    let browStyles: [Style]
    let eyeStyles: [Style]
    let beardStyles: [Style]
    let tieStyles: [Style]
    let accessories: [Style]
    let palettes: [String: [String]]

    /// Style options for a given config key.
    func styles(for key: String) -> [Style] {
        switch key {
        case "model": return models
        case "hairStyle": return hairStyles
        case "topStyle": return topStyles
        case "bottomStyle": return bottomStyles
        case "browStyle": return browStyles
        case "eyeStyle": return eyeStyles
        case "beardStyle": return beardStyles
        case "tieStyle": return tieStyles
        case "accessory": return accessories
        default: return []
        }
    }
}
