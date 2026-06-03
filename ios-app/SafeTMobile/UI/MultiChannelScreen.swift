import SwiftUI

struct MultiChannelScreen: View {
    let api: RadioApiClient
    @Environment(\.dismiss) var dismiss

    @State private var channels: [String] = []
    @State private var visibleChannels: Set<String> = []
    @State private var selectedChannels: Set<String> = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Button("ALL") {
                    visibleChannels = Set(channels)
                }
                .font(.system(size: 12, weight: .bold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(visibleChannels.count == channels.count ? Color.safetBlue : Color.safetSurface)
                .foregroundColor(.safetText)
                .cornerRadius(6)

                Button("NONE") {
                    visibleChannels.removeAll()
                }
                .font(.system(size: 12, weight: .bold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(visibleChannels.isEmpty ? Color.safetBlue : Color.safetSurface)
                .foregroundColor(.safetText)
                .cornerRadius(6)

                Spacer()
                Text("\(visibleChannels.count)/\(channels.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.safetTextDim)
            }
            .padding(.horizontal, 12)

            if let error {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.safetRed)
                    .padding(.horizontal, 12)
            }

            ScrollView {
                VStack(spacing: 8) {
                    if loading {
                        ProgressView().tint(.safetText)
                    } else if channels.isEmpty {
                        Text("NO CHANNELS")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.safetTextDim)
                            .padding(.top, 24)
                    } else {
                        ForEach(channels, id: \.self) { channel in
                            channelRow(channel)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }

            HStack(spacing: 10) {
                Button("CLOSE") {
                    dismiss()
                }
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(.safetText)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Color.safetSurface)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
                .cornerRadius(8)
            }
            .padding(.horizontal, 12)
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Color.safetBackground.ignoresSafeArea())
        .navigationTitle("MULTI-CHANNEL")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadChannels()
        }
    }

    private func channelRow(_ channel: String) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(channel.uppercased())
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.safetText)
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { visibleChannels.contains(channel) },
                set: { newValue in
                    if newValue {
                        visibleChannels.insert(channel)
                    } else {
                        visibleChannels.remove(channel)
                    }
                }
            ))
            .labelsHidden()
            .tint(.safetGreen)
        }
        .padding(12)
        .background(visibleChannels.contains(channel) ? Color.safetGreen.opacity(0.1) : Color.safetSurface)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(
            visibleChannels.contains(channel) ? Color.safetGreen : Color.safetBorder,
            lineWidth: 1
        ))
        .cornerRadius(8)
    }

    private func loadChannels() async {
        loading = true
        do {
            let channels = try await api.channels()
            self.channels = channels.map(\.name).sorted()
            visibleChannels = Set(self.channels)
            error = nil
        } catch {
            self.error = "Failed to load channels: \(error)"
        }
        loading = false
    }
}
