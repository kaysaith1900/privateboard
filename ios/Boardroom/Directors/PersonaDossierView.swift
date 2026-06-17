import SwiftUI

/// The full Persona dossier · native counterpart of the desktop
/// `openPersonaOverlay` markdown modal. Renders the 7-phase `PersonaBuilder`
/// output (`personaSpec`) section-by-section in the app's own type system rather
/// than fetching a `.md` — persona spec (lineage / load-bearing concepts /
/// referent set / failure modes / contrarian takes), behavioural rules,
/// few-shot examples, reflection checklist, and the eval set. Only the sections
/// the build actually produced are shown. Presented as a sheet from the profile.
struct PersonaDossierView: View {
    let name: String
    let spec: PersonaSpec
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    classifiedHeader
                    specSection
                    rulesSection
                    fewShotSection
                    reflectionSection
                    evalSection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .padding(.bottom, 24)
            }
            .scrollContentBackground(.hidden)
            .background(Color.bbBg.ignoresSafeArea())
            .navigationTitle(Loc.t("m_dossier_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(Loc.t("common_done")) { dismiss() } } }
        }
    }

    // MARK: Header

    private var classifiedHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle().fill(Color.bbGold).frame(width: 7, height: 7)
                Text(Loc.t("m_dossier_classified"))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.8)
                    .foregroundStyle(Color.bbGold)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            Text(name).font(.system(size: 26, weight: .bold)).foregroundStyle(Color.bbInk)
            if let date = builtDate {
                Text(Loc.t("m_dossier_built", ["date": date]))
                    .font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkDim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Persona spec

    @ViewBuilder
    private var specSection: some View {
        if let s = spec.spec, specHasContent(s) {
            sectionCard(Loc.t("m_dossier_spec")) {
                bulletGroup(Loc.t("m_dossier_lineage"), s.intellectualLineage)
                bulletGroup(Loc.t("m_dossier_loadbearing"), s.loadBearingConcepts)
                bulletGroup(Loc.t("m_dossier_referentset"), s.referentSet)
                bulletGroup(Loc.t("m_dossier_failure"), s.failureModes)
                bulletGroup(Loc.t("m_dossier_contrarian"), s.contrarianTakes)
            }
        }
    }

    // MARK: Behavioural rules

    @ViewBuilder
    private var rulesSection: some View {
        let rules = spec.rules?.filter { !($0.rule ?? "").isEmpty } ?? []
        if !rules.isEmpty {
            sectionCard(Loc.t("m_dossier_rules_h")) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(rules.enumerated()), id: \.offset) { _, r in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(ruleKindLabel(r.kind))
                                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.5)
                                .foregroundStyle(Color.bbGold)
                                .frame(width: 52, alignment: .leading)
                            Text(r.rule ?? "")
                                .font(.system(size: 15)).foregroundStyle(Color.bbInk)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    // MARK: Few-shot

    @ViewBuilder
    private var fewShotSection: some View {
        let shots = spec.fewShot?.filter { !($0.scenario ?? "").isEmpty || !($0.personaResponse ?? "").isEmpty } ?? []
        if !shots.isEmpty {
            sectionCard(Loc.t("m_dossier_fewshot")) {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(shots.enumerated()), id: \.offset) { i, ex in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(Loc.t("m_dossier_example", ["n": String(i + 1)]))
                                .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.6)
                                .foregroundStyle(Color.bbInkDim)
                            if let sc = ex.scenario, !sc.isEmpty {
                                labeledBody(Loc.t("m_dossier_scenario"), sc, accent: false)
                            }
                            if let g = ex.genericResponse, !g.isEmpty {
                                labeledBody(Loc.t("m_dossier_generic"), g, accent: false, dim: true)
                            }
                            if let p = ex.personaResponse, !p.isEmpty {
                                labeledBody(Loc.t("m_dossier_persona"), p, accent: true)
                            }
                            if let why = ex.rationale, !why.isEmpty {
                                Text(why).font(.system(size: 13).italic()).foregroundStyle(Color.bbInkDim)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        if i < shots.count - 1 { Rectangle().fill(Color.bbLine).frame(height: 1) }
                    }
                }
            }
        }
    }

    // MARK: Reflection checklist

    @ViewBuilder
    private var reflectionSection: some View {
        let items = spec.reflectionChecklist?.filter { !$0.isEmpty } ?? []
        if !items.isEmpty {
            sectionCard(Loc.t("m_dossier_reflection")) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Loc.t("m_dossier_reflection_sub"))
                        .font(.system(size: 13).italic()).foregroundStyle(Color.bbInkDim)
                    ForEach(Array(items.enumerated()), id: \.offset) { i, q in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(String(format: "%02d", i + 1))
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.bbGold).frame(width: 24, alignment: .leading)
                            Text(q).font(.system(size: 15)).foregroundStyle(Color.bbInk)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    // MARK: Eval set

    @ViewBuilder
    private var evalSection: some View {
        let evals = spec.evalSet?.filter { !($0.prompt ?? "").isEmpty } ?? []
        if !evals.isEmpty {
            sectionCard(Loc.t("m_dossier_eval")) {
                VStack(alignment: .leading, spacing: 14) {
                    Text(Loc.t("m_dossier_eval_sub"))
                        .font(.system(size: 13).italic()).foregroundStyle(Color.bbInkDim)
                    ForEach(Array(evals.enumerated()), id: \.offset) { i, e in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(String(format: "%02d", i + 1))
                                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(Color.bbGold)
                                Text(e.prompt ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.bbInk)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if let sig = e.expectedSignature, !sig.isEmpty {
                                Text(sig).font(.system(size: 13)).foregroundStyle(Color.bbInkDim)
                                    .padding(.leading, 21)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Building blocks

    private func sectionCard(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .monospaced)).kerning(0.8)
                .foregroundStyle(Color.bbInkDim)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    @ViewBuilder
    private func bulletGroup(_ label: String, _ items: [String]?) -> some View {
        let list = items?.filter { !$0.isEmpty } ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Text(label)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.5)
                    .foregroundStyle(Color.bbGold)
                ForEach(Array(list.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("·").font(.system(size: 15)).foregroundStyle(Color.bbInkDim)
                        Text(item).font(.system(size: 15)).foregroundStyle(Color.bbInk)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func labeledBody(_ label: String, _ body: String, accent: Bool, dim: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced)).kerning(0.5)
                .foregroundStyle(accent ? Color.bbGold : Color.bbInkFaint)
            Text(body).font(.system(size: 15))
                .foregroundStyle(dim ? Color.bbInkDim : Color.bbInk)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Helpers

    private func specHasContent(_ s: PersonaSpec.Core) -> Bool {
        [(s.intellectualLineage), (s.loadBearingConcepts), (s.referentSet), (s.failureModes), (s.contrarianTakes)]
            .compactMap { $0 }.flatMap { $0 }.contains { !$0.isEmpty }
    }

    private func ruleKindLabel(_ kind: String?) -> String {
        switch (kind ?? "").lowercased() {
        case "always": return Loc.t("m_dossier_always")
        case "never": return Loc.t("m_dossier_never")
        default: return Loc.t("m_dossier_when")
        }
    }

    private var builtDate: String? {
        guard let raw = spec.generatedAt, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        guard let d = iso.date(from: raw) ?? ISO8601DateFormatter.withFractionalSeconds.date(from: raw) else { return nil }
        let f = DateFormatter(); f.dateFormat = "MMM d, yyyy"
        return f.string(from: d)
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
}
