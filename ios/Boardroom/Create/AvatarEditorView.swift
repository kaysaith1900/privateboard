import SwiftUI

/// Native 3D-avatar customiser · a FULL-SCREEN live WebGL figure with two vertical
/// rails of per-dimension buttons (icon + label + current-colour dot) on the left
/// (Head) and right (Outfit) edges. Tapping a rail button raises a bottom sheet
/// whose style pills + colour swatches WRAP (FlowLayout, no horizontal scroll).
/// Every tap pushes the edited config to the live preview; Save captures a head-on
/// PNG and hands back (png, config). The controller + embed are untouched.
struct AvatarEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var controller: AvatarEditorController
    @State private var saving = false
    @State private var activeDim: AvModule?        // nil = no sheet · drives .sheet(item:)

    let url: URL
    var onSave: (String, Avatar3DConfig) -> Void

    init(url: URL, seed: String, existing: Avatar3DConfig?,
         onSave: @escaping (String, Avatar3DConfig) -> Void) {
        self.url = url
        self.onSave = onSave
        let c = AvatarEditorController()
        c.seed = seed
        c.existingJSON = existing?.jsonString()   // set before the embed boots → markReady reads it
        _controller = State(initialValue: c)
    }

    private var ready: Bool { controller.catalog != nil && controller.config != nil }

    var body: some View {
        ZStack {
            // Backdrop.
            RadialGradient(colors: [Color(white: 0.16), .black], center: .center, startRadius: 10, endRadius: 600)
                .ignoresSafeArea()

            // Full-screen live 3D figure · stays full-size behind the sheet.
            AvatarEditorWebView(url: url, controller: controller)
                .ignoresSafeArea()

            // Side rails · Head (left) / Outfit (right), vertically centred on screen.
            if ready {
                HStack(alignment: .center) {
                    railColumn(Self.headModules)
                    Spacer()
                    railColumn(Self.outfitModules)
                }
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }

            // Top chrome.
            topBar.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

            if !ready {
                if controller.loadFailed {
                    VStack(spacing: 14) {
                        Text(Loc.t("av3d_load_failed"))
                            .font(.system(size: 14)).foregroundStyle(Color.bbInkDim)
                            .multilineTextAlignment(.center)
                        Button(Loc.t("av3d_retry")) { controller.retry() }
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(.black)
                            .padding(.horizontal, 22).frame(height: 44)
                            .background(Color.bbGold, in: Capsule())
                    }
                    .padding(28)
                } else {
                    ProgressView().tint(.bbGold)
                }
            }
            if saving { savingOverlay }
        }
        // isPresented (not item) so tapping a different rail button while the sheet
        // is open swaps its CONTENT live instead of being ignored.
        // SheetHost holds a Binding to activeDim, so it RE-RENDERS in place when a
        // different rail button is tapped while the sheet is open — swapping the
        // content live (a plain `if let` in the .sheet closure does NOT re-evaluate).
        .sheet(isPresented: Binding(get: { activeDim != nil }, set: { if !$0 { activeDim = nil } })) {
            SheetHost(dim: $activeDim, controller: controller, onStyle: setStyle, onColor: setColor)
        }
    }

    // ── Top chrome ─────────────────────────────────────────────────
    private var topBar: some View {
        HStack(spacing: 12) {
            GlassIconButton(system: "xmark") { dismiss() }
            Spacer()
            GlassIconButton(system: "dice", tint: .bbGold) { randomizeColors() }
                .disabled(saving)
                .accessibilityLabel(Loc.t("av3d_rand"))
            Button { save() } label: {
                Text(Loc.t("av3d_save"))
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(.black)
                    .padding(.horizontal, 18).frame(height: 44)
            }
            .buttonStyle(.plain)
            .background(Color.bbGold, in: Capsule())
            .glassEffect(.regular.interactive(), in: Capsule())
            .disabled(saving || controller.config == nil)
        }
        .padding(.horizontal, 16).padding(.top, 6)
    }

    // ── Side rails ─────────────────────────────────────────────────
    private func railColumn(_ modules: [AvModule]) -> some View {
        VStack(spacing: 10) {
            ForEach(modules) { m in railButton(m) }
        }
    }

    private func railButton(_ m: AvModule) -> some View {
        let on = activeDim?.id == m.id
        let dot = m.color.flatMap { controller.config?[$0] }
        return Button { activeDim = m } label: {
            VStack(spacing: 3) {
                Image(systemName: m.icon).font(.system(size: 18, weight: .semibold))
                Text(Loc.t(m.label)).font(.system(size: 9, weight: .semibold))
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .foregroundStyle(on ? Color.bbGold : Color.bbInk)
            .frame(width: 56, height: 50)
            .overlay(alignment: .bottomTrailing) {
                if let dot {
                    Circle().fill(Self.swatch(dot)).frame(width: 9, height: 9)
                        .overlay(Circle().stroke(Color.black.opacity(0.4), lineWidth: 1))
                        .padding(5)
                }
            }
            .contentShape(Rectangle())   // whole capsule tappable, not just the glyph
        }
        .buttonStyle(.plain)
        .glassEffect(on ? .regular.tint(.bbGold.opacity(0.5)).interactive() : .regular.interactive(),
                     in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var savingOverlay: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
            ProgressView().tint(.bbGold).scaleEffect(1.3)
        }
    }

    // ── Edits (live → preview, kept as the truth in controller.config) ──
    private func setStyle(_ key: String, _ id: String) {
        guard var cfg = controller.config, cfg[key] != id else { return }
        cfg[key] = id
        controller.apply(cfg)
    }
    private func setColor(_ key: String, _ hex: String) {
        guard var cfg = controller.config, cfg[key].caseInsensitiveCompare(hex) != .orderedSame else { return }
        cfg[key] = hex
        controller.apply(cfg)
    }

    /// Desktop `randomize()` · shuffles the 8 COLOUR channels only (skin / hair /
    /// brow / beard / eye / top / bottom / tie), never the style dimensions.
    private func randomizeColors() {
        guard var cfg = controller.config, let cat = controller.catalog else { return }
        for key in ["skin", "hair", "brow", "beard", "eye", "top", "bottom", "tie"] {
            if let pick = cat.palettes[key]?.randomElement() { cfg[key] = pick }
        }
        controller.apply(cfg)
    }

    private func save() {
        guard let cfg = controller.config else { return }
        saving = true
        Task {
            let png = await controller.capture(size: 512)
            saving = false
            if let png, !png.isEmpty { onSave(png, cfg); dismiss() }
        }
    }

    static func swatch(_ hex: String) -> Color {
        var s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard let v = UInt32(s, radix: 16), s.count == 6 else { return .gray }
        return Color(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    // ── Dimension descriptors · desktop parity (avatar3d-editor.js) ──
    // Body "model" is intentionally NOT user-selectable. Head dims left, Outfit
    // dims right (mirrors the desktop's two sections). Each pairs its style pills
    // with its colour under one label; the id (== label key) drives .sheet(item:).
    struct AvModule: Identifiable {
        let id: String, label: String
        let style: String?, color: String?
        let icon: String
        init(_ label: String, style: String? = nil, color: String? = nil, icon: String) {
            self.id = label; self.label = label; self.style = style; self.color = color; self.icon = icon
        }
    }
    static let headModules: [AvModule] = [
        .init("av3d_lab_hair",  style: "hairStyle",  color: "hair",  icon: "comb"),
        .init("av3d_lab_brow",  style: "browStyle",  color: "brow",  icon: "eyebrow"),
        .init("av3d_lab_beard", style: "beardStyle", color: "beard", icon: "mustache"),
        .init("av3d_lab_skin",  style: nil,          color: "skin",  icon: "paintpalette"),
        .init("av3d_lab_eye",   style: "eyeStyle",   color: "eye",   icon: "eye"),
    ]
    static let outfitModules: [AvModule] = [
        .init("av3d_lab_top",       style: "topStyle",    color: "top",    icon: "tshirt"),
        .init("av3d_lab_bottom",    style: "bottomStyle", color: "bottom", icon: "figure.walk"),
        .init("av3d_lab_tie",       style: "tieStyle",    color: "tie",    icon: "link"),
        .init("av3d_lab_accessory", style: "accessory",   color: nil,      icon: "eyeglasses"),
    ]
}

// MARK: - Per-dimension bottom sheet

/// Hosts the active dimension's sheet · holds a Binding to `activeDim` so it
/// re-renders IN PLACE when a different rail button is tapped while the sheet is
/// open (the `.sheet` content closure alone won't re-evaluate). Applies the shared
/// glass presentation chrome once.
private struct SheetHost: View {
    @Binding var dim: AvatarEditorView.AvModule?
    let controller: AvatarEditorController
    let onStyle: (String, String) -> Void
    let onColor: (String, String) -> Void

    var body: some View {
        Group {
            if let d = dim {
                DimensionSheet(dim: d, controller: controller, onStyle: onStyle, onColor: onColor)
            }
        }
        .presentationBackground { Color.clear.glassEffect(.regular, in: Rectangle()) }
        .presentationDragIndicator(.visible)
    }
}

/// One dimension's options · style pills + colour swatches, both WRAPPED (no
/// horizontal scroll). The sheet height fits its content (adaptive `.height`
/// detent). Selecting a pill/swatch edits live through the parent's
/// `onStyle`/`onColor` → `controller.apply`; the figure behind the sheet updates.
private struct DimensionSheet: View {
    let dim: AvatarEditorView.AvModule
    let controller: AvatarEditorController
    let onStyle: (String, String) -> Void
    let onColor: (String, String) -> Void
    @State private var contentHeight: CGFloat = 280

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(Loc.t(dim.label).uppercased())
                    .font(.bbKicker(13)).kerning(1.6).foregroundStyle(Color.bbGold)

                if let key = dim.style, let cat = controller.catalog {
                    let opts = cat.styles(for: key)
                    if !opts.isEmpty {
                        FlowLayout(spacing: 8, lineSpacing: 8) {
                            ForEach(opts) { opt in stylePill(key, opt) }
                        }
                    }
                }
                if let key = dim.color, let pal = controller.catalog?.palettes[key], !pal.isEmpty {
                    FlowLayout(spacing: 10, lineSpacing: 10) {
                        ForEach(pal, id: \.self) { hex in colorSwatch(key, hex) }
                    }
                }
            }
            .padding(20).padding(.top, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        // Adaptive height · the sheet hugs its content (drag-indicator allowance),
        // capped so very tall dimensions still scroll instead of covering the figure.
        .presentationDetents([.height(min(max(contentHeight + 24, 180), 560))])
    }

    private func stylePill(_ key: String, _ opt: AvatarCatalog.Style) -> some View {
        let on = controller.config?[key] == opt.id
        return Button { onStyle(key, opt.id) } label: {
            Text(optLabel(key, opt))
                .font(.system(size: 14, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? Color.bbGold : Color.bbInk)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(on ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.06), in: Capsule())
                .overlay(Capsule().stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func colorSwatch(_ key: String, _ hex: String) -> some View {
        let on = controller.config?[key].caseInsensitiveCompare(hex) == .orderedSame
        return Button { onColor(key, hex) } label: {
            Circle()
                .fill(AvatarEditorView.swatch(hex))
                .frame(width: 32, height: 32)
                .overlay(Circle().stroke(on ? Color.bbGold : Color.bbLine, lineWidth: on ? 2.5 : 1))
                .padding(2)
        }
        .buttonStyle(.plain)
    }

    /// Option label · i18n key `av3d_opt_<role>_<id>`, fall back to baked label.
    private func optLabel(_ role: String, _ opt: AvatarCatalog.Style) -> String {
        let k = "av3d_opt_\(role)_\(opt.id)"
        let s = Loc.t(k)
        return s == k ? opt.label : s
    }
}

// MARK: - FlowLayout (wraps subviews onto multiple lines)

/// Lays subviews left→right, wrapping to a new line when the next one would
/// overflow the proposed width. Works for variable-width pills and fixed swatches.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxRowW: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > maxW {                 // wrap
                maxRowW = max(maxRowW, x - spacing)
                x = 0; y += rowH + lineSpacing; rowH = 0
            }
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
        maxRowW = max(maxRowW, x - spacing)
        return CGSize(width: maxW.isFinite ? min(maxW, maxRowW) : maxRowW, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxW = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > maxW {                 // wrap
                x = 0; y += rowH + lineSpacing; rowH = 0
            }
            s.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                    anchor: .topLeading, proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}
