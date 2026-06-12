import SwiftUI

/// Multi-select picker for the scan list. The home (tuned) channel is shown
/// dimmed and non-toggleable — it's implicitly part of "what you hear" via
/// the primary voice transport, so adding it to scan would just double up.
struct ScanPickerScreen: View {
    let channels: [String]
    let homeChannel: String?
    @Binding var selection: Set<String>

    var body: some View {
        List {
            Section {
                ForEach(channels, id: \.self) { name in
                    row(name)
                }
            } header: {
                Text("Tap a channel to include it in scan. The currently tuned channel is always heard.")
                    .font(.safet(size: 12))
                    .foregroundColor(.safetTextDim)
                    .textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.safetBackground)
        .navigationTitle("SCAN LIST")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func row(_ name: String) -> some View {
        let isHome = name.lowercased() == (homeChannel ?? "").lowercased()
        let isSelected = selection.contains(name.lowercased())
        Button {
            guard !isHome else { return }
            let key = name.lowercased()
            if isSelected {
                selection.remove(key)
            } else {
                selection.insert(key)
            }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.safet(size: 15, weight: .semibold))
                        .foregroundColor(isHome ? .safetTextDim : .safetText)
                    if isHome {
                        Text("HOME — ALWAYS LIVE")
                            .font(.safet(size: 10, weight: .bold, design: .monospaced))
                            .foregroundColor(.safetSignal)
                    }
                }
                Spacer()
                if isHome {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .foregroundColor(.safetSignal)
                } else if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.safetGreen)
                } else {
                    Image(systemName: "circle")
                        .foregroundColor(.safetTextDim)
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(isHome)
        .listRowBackground(Color.safetSurface)
    }
}
