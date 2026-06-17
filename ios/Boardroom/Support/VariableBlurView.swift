import SwiftUI
import UIKit

/// Progressive (variable) blur — the iOS Photos / Music top-bar treatment, where
/// the blur RADIUS ramps from clear at the bottom to full at the top, instead of
/// a uniform `.ultraThinMaterial` faded by opacity (which on a dark app reads as
/// a flat gray-white film — the "劣质" look). Backed by CoreAnimation's
/// `variableBlur` filter (the same primitive the system bars use) with a vertical
/// alpha-gradient mask, and with the visual-effect view's gray tint sublayers
/// stripped so the blur stays content-tinted (dark over dark) rather than milky.
struct VariableBlurView: UIViewRepresentable {
    var maxBlurRadius: CGFloat = 18

    func makeUIView(context: Context) -> VariableBlurUIView {
        VariableBlurUIView(maxBlurRadius: maxBlurRadius)
    }
    func updateUIView(_ uiView: VariableBlurUIView, context: Context) {}
}

final class VariableBlurUIView: UIVisualEffectView {
    init(maxBlurRadius: CGFloat) {
        super.init(effect: UIBlurEffect(style: .regular))

        // CAFilter("variableBlur") · resolved by name so the symbol isn't linked
        // directly. This is the primitive the system's own progressive bar blurs
        // use; there's no public SwiftUI equivalent.
        guard let filterClass = NSClassFromString("CAFilter") as? NSObject.Type else { return }
        let make = NSSelectorFromString("filterWithType:")
        guard filterClass.responds(to: make),
              let filter = filterClass.perform(make, with: "variableBlur")?.takeUnretainedValue() as? NSObject
        else { return }

        // Vertical alpha ramp · opaque (full blur) at the top → clear (no blur) at
        // the bottom, so the chrome blurs hard under the status bar and content
        // emerges sharp below the header.
        let gradient = CAGradientLayer()
        gradient.frame = CGRect(x: 0, y: 0, width: 100, height: 100)
        gradient.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        gradient.locations = [0, 0.5, 1]
        gradient.startPoint = CGPoint(x: 0.5, y: 0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
        let mask = UIGraphicsImageRenderer(size: gradient.frame.size)
            .image { gradient.render(in: $0.cgContext) }.cgImage

        filter.setValue(maxBlurRadius, forKey: "inputRadius")
        filter.setValue(mask, forKey: "inputMaskImage")
        filter.setValue(true, forKey: "inputNormalizeEdges")

        // Apply the variable blur to the backdrop layer and strip the gray
        // tint/vibrancy overlay sublayers (subviews[1...]) — those are the milky
        // film that makes a plain material look cheap on a dark surface.
        if let backdrop = subviews.first {
            backdrop.layer.filters = [filter]
            backdrop.layer.setValue(true, forKey: "allowsGroupBlending")
        }
        for sub in subviews.dropFirst() { sub.alpha = 0 }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        subviews.first?.frame = bounds   // keep the backdrop covering the full band
    }
}
