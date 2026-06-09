import UIKit

/// The root UIKit view that assembles the tab bar with glass effects.
/// Uses UIGlassContainerEffect to enable morphing between the segmented control and FAB.
@available(iOS 26.0, *)
final class GlassTabBarView: UIView {
    let containerEffectView: UIVisualEffectView
    let segmentedGlassView: UIVisualEffectView
    let segmentedControl: TabBarSegmentedControl
    let fabGlassView: UIVisualEffectView
    let fabButton: UIButton
    private var fabImage: UIImage?        // the "+" glyph · toggled off while loading

    private let spacing: CGFloat = Constants.fabSpacing
    private let contentPadding: CGFloat = Constants.contentPadding

    private(set) var tabCount: Int
    private var segmentedTrailingConstraint: NSLayoutConstraint?

    init(
        segmentedControl: TabBarSegmentedControl,
        tabCount: Int,
        action: FabBarAction
    ) {
        self.segmentedControl = segmentedControl
        self.tabCount = tabCount

        // Create glass container effect for morphing
        let containerEffect = UIGlassContainerEffect()
        containerEffect.spacing = Constants.fabSpacing
        containerEffectView = UIVisualEffectView(effect: containerEffect)

        // Create segmented control glass effect
        let segmentedGlassEffect = UIGlassEffect()
        segmentedGlassEffect.isInteractive = true
        segmentedGlassView = UIVisualEffectView(effect: segmentedGlassEffect)

        // Create FAB button.
        // Boardroom override: keep the FAB as CLEAR regular glass (no tint) with
        // a gold glyph — matching the app's other glass icon buttons — rather
        // than FabBar's default solid tinted-glass FAB.
        let fabGlassEffect = UIGlassEffect()
        fabGlassEffect.isInteractive = true
        fabGlassView = UIVisualEffectView(effect: fabGlassEffect)

        let button = UIButton(type: .system)
        let config = UIImage.SymbolConfiguration(pointSize: Constants.fabIconPointSize, weight: .medium)
        let buttonImage = UIImage(systemName: action.systemImage, withConfiguration: config)
        button.setImage(buttonImage, for: .normal)
        button.tintColor = UIColor(red: 0xC9/255, green: 0xA4/255, blue: 0x6B/255, alpha: 1)   // bbGold glyph
        button.accessibilityLabel = action.accessibilityLabel
        button.accessibilityTraits = .button
        fabButton = button
        fabImage = buttonImage

        super.init(frame: .zero)

        // Ensure tint adjustment mode is automatic so views dim when sheets are presented
        tintAdjustmentMode = .automatic
        fabGlassView.tintAdjustmentMode = .automatic
        fabButton.tintAdjustmentMode = .automatic

        setupViews(action: action)
    }

    private func setupViews(action: FabBarAction) {
        // Add container effect view
        addSubview(containerEffectView)
        containerEffectView.translatesAutoresizingMaskIntoConstraints = false

        // Add segmented glass view to container's contentView
        containerEffectView.contentView.addSubview(segmentedGlassView)
        segmentedGlassView.translatesAutoresizingMaskIntoConstraints = false

        // Add segmented control to segmented glass view's contentView
        segmentedGlassView.contentView.addSubview(segmentedControl)
        segmentedControl.translatesAutoresizingMaskIntoConstraints = false

        // Add FAB glass view
        containerEffectView.contentView.addSubview(fabGlassView)
        fabGlassView.translatesAutoresizingMaskIntoConstraints = false

        fabGlassView.contentView.addSubview(fabButton)
        fabButton.translatesAutoresizingMaskIntoConstraints = false

        // Store action for button
        fabButton.addAction(UIAction { _ in action.action() }, for: .touchUpInside)

        // Extra bottom inset compensates for UISegmentedControl's internal padding,
        // visually centering the content within the glass container.
        let segmentedControlBottomInsetAdjustment: CGFloat = 1

        NSLayoutConstraint.activate([
            containerEffectView.leadingAnchor.constraint(equalTo: leadingAnchor),
            containerEffectView.trailingAnchor.constraint(equalTo: trailingAnchor),
            containerEffectView.topAnchor.constraint(equalTo: topAnchor),
            containerEffectView.bottomAnchor.constraint(equalTo: bottomAnchor),

            segmentedGlassView.leadingAnchor.constraint(equalTo: containerEffectView.contentView.leadingAnchor),
            segmentedGlassView.topAnchor.constraint(equalTo: containerEffectView.contentView.topAnchor),
            segmentedGlassView.bottomAnchor.constraint(equalTo: containerEffectView.contentView.bottomAnchor),

            segmentedControl.leadingAnchor.constraint(equalTo: segmentedGlassView.contentView.leadingAnchor, constant: contentPadding),
            segmentedControl.trailingAnchor.constraint(equalTo: segmentedGlassView.contentView.trailingAnchor, constant: -contentPadding),
            segmentedControl.topAnchor.constraint(equalTo: segmentedGlassView.contentView.topAnchor, constant: contentPadding),
            segmentedControl.bottomAnchor.constraint(equalTo: segmentedGlassView.contentView.bottomAnchor, constant: -contentPadding - segmentedControlBottomInsetAdjustment),

            // FAB glass view
            fabGlassView.trailingAnchor.constraint(equalTo: containerEffectView.contentView.trailingAnchor),
            fabGlassView.topAnchor.constraint(equalTo: containerEffectView.contentView.topAnchor),
            fabGlassView.bottomAnchor.constraint(equalTo: containerEffectView.contentView.bottomAnchor),
            fabGlassView.widthAnchor.constraint(equalTo: fabGlassView.heightAnchor),

            // Fill the entire glass area so taps anywhere trigger the action
            fabButton.leadingAnchor.constraint(equalTo: fabGlassView.contentView.leadingAnchor),
            fabButton.trailingAnchor.constraint(equalTo: fabGlassView.contentView.trailingAnchor),
            fabButton.topAnchor.constraint(equalTo: fabGlassView.contentView.topAnchor),
            fabButton.bottomAnchor.constraint(equalTo: fabGlassView.contentView.bottomAnchor),
        ])

        // Set up the trailing constraint based on tab count
        segmentedTrailingConstraint = makeSegmentedTrailingConstraint()
        segmentedTrailingConstraint?.isActive = true
    }

    /// Creates the appropriate trailing constraint for the segmented glass view.
    /// For 3+ tabs, fills to the FAB. For fewer tabs, floats leading-aligned.
    private func makeSegmentedTrailingConstraint() -> NSLayoutConstraint {
        if tabCount >= 3 {
            segmentedGlassView.trailingAnchor.constraint(equalTo: fabGlassView.leadingAnchor, constant: -spacing)
        } else {
            segmentedGlassView.trailingAnchor.constraint(lessThanOrEqualTo: fabGlassView.leadingAnchor, constant: -spacing)
        }
    }

    /// Updates the tab count and swaps the trailing constraint to match.
    func updateTabCount(_ newCount: Int) {
        guard newCount != tabCount else { return }
        tabCount = newCount
        segmentedTrailingConstraint?.isActive = false
        segmentedTrailingConstraint = makeSegmentedTrailingConstraint()
        segmentedTrailingConstraint?.isActive = true
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        // Capsule shape for segmented control
        segmentedGlassView.cornerConfiguration = .capsule()

        // Circle shape for FAB button (capsule with equal width/height = circle)
        fabGlassView.cornerConfiguration = .capsule()
    }

    // Boardroom: a gamified gold "orbit" loader overlaid on the FAB while a long
    // task (the director persona build) runs in the background — the "+" glyph is
    // swapped OUT (setImage nil · reliable on a .system button, unlike imageView
    // alpha which left the "+" showing through) and the button stays tappable
    // (tap reopens the in-progress build).
    private lazy var fabLoader: FabOrbitLoader = {
        let s = FabOrbitLoader()
        s.translatesAutoresizingMaskIntoConstraints = false
        fabGlassView.contentView.addSubview(s)
        NSLayoutConstraint.activate([
            s.centerXAnchor.constraint(equalTo: fabButton.centerXAnchor),
            s.centerYAnchor.constraint(equalTo: fabButton.centerYAnchor),
            s.widthAnchor.constraint(equalToConstant: 26),
            s.heightAnchor.constraint(equalToConstant: 26),
        ])
        return s
    }()

    func setActionLoading(_ loading: Bool) {
        if loading {
            fabButton.setImage(nil, for: .normal)   // fully remove the "+" (no overlap)
            fabLoader.start()
        } else {
            fabLoader.stop()
            fabButton.setImage(fabImage, for: .normal)
        }
    }

    // Boardroom override: FAB is clear (untinted) glass, so no tint to track
    // on tintColor changes — leave its effect as-is.
}

/// Gamified FAB loader · a faint gold track ring with two gold arcs orbiting at
/// different speeds + a soft pulse — replaces the flat system spinner so a
/// background persona build reads as "the board is assembling", on-brand gold.
final class FabOrbitLoader: UIView {
    private let gold = UIColor(red: 0xC9/255, green: 0xA4/255, blue: 0x6B/255, alpha: 1)
    private let track = CAShapeLayer()
    private let arcA = CAShapeLayer()
    private let arcB = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false      // taps fall through to the FAB
        isHidden = true
        track.fillColor = UIColor.clear.cgColor
        track.strokeColor = gold.withAlphaComponent(0.16).cgColor
        for arc in [arcA, arcB] {
            arc.fillColor = UIColor.clear.cgColor
            arc.strokeColor = gold.cgColor
            arc.lineCap = .round
        }
        layer.addSublayer(track)
        layer.addSublayer(arcA)
        layer.addSublayer(arcB)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset: CGFloat = 2
        let outerR = min(bounds.width, bounds.height) / 2 - inset
        let innerR = outerR - 5
        func ring(_ r: CGFloat) -> CGPath {
            UIBezierPath(arcCenter: CGPoint(x: bounds.midX, y: bounds.midY), radius: r,
                         startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        }
        for (l, r, w) in [(track, outerR, CGFloat(2)), (arcA, outerR, 2.2), (arcB, innerR, 1.8)] {
            l.path = ring(r); l.lineWidth = w; l.frame = bounds
        }
        arcA.strokeStart = 0; arcA.strokeEnd = 0.30      // outer · longer arc
        arcB.strokeStart = 0; arcB.strokeEnd = 0.18      // inner · shorter, counter-spins
    }

    func start() {
        isHidden = false
        guard arcA.animation(forKey: "spin") == nil else { return }
        addSpin(to: arcA, duration: 0.95, clockwise: true)
        addSpin(to: arcB, duration: 0.70, clockwise: false)
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 0.85; pulse.toValue = 1.0
        pulse.duration = 0.6; pulse.autoreverses = true; pulse.repeatCount = .infinity
        layer.add(pulse, forKey: "pulse")
    }
    func stop() {
        arcA.removeAnimation(forKey: "spin"); arcB.removeAnimation(forKey: "spin")
        layer.removeAnimation(forKey: "pulse")
        isHidden = true
    }
    private func addSpin(to l: CALayer, duration: CFTimeInterval, clockwise: Bool) {
        let a = CABasicAnimation(keyPath: "transform.rotation.z")
        a.fromValue = 0
        a.toValue = (clockwise ? 1 : -1) * 2 * Double.pi
        a.duration = duration
        a.repeatCount = .infinity
        l.add(a, forKey: "spin")
    }
}
