import SwiftUI
import UIKit

/// The radio's page inbox — messages sent from dispatch (optionally with a
/// picture), with quick-reply ACK buttons. Mirrors the Android Messages tab.
struct PagesScreen: View {
    let state: RadioUiState
    let onEvent: (RadioUiEvent) -> Void

    private let quickReplies = ["ACK", "EN ROUTE", "UNABLE"]

    var body: some View {
        ScrollView {
            if state.pageMessages.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tray")
                        .font(.safet(size: 34, weight: .bold))
                    Text("NO PAGES")
                        .font(.safet(size: 14, weight: .heavy))
                }
                .foregroundColor(.safetTextDim)
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(state.pageMessages) { page in
                        pageRow(page)
                    }
                }
                .padding(14)
            }
        }
        .background(Color.safetBackground.ignoresSafeArea())
        .onAppear { onEvent(.markPagesRead) }
    }

    @ViewBuilder
    private func pageRow(_ page: PageMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: page.targetedToMe ? "person.crop.circle.fill" : "megaphone.fill")
                    .font(.safet(size: 11, weight: .bold))
                    .foregroundColor(page.targetedToMe ? .safetBlue : .safetSignal)
                Text((page.targetedToMe ? "DIRECT • " : "PAGE • ") + page.fromLabel)
                    .font(.safet(size: 12, weight: .heavy))
                    .foregroundColor(.safetText)
                Spacer()
                Text(page.timeLabel)
                    .font(.safet(size: 11, weight: .semibold))
                    .foregroundColor(.safetTextDim)
            }
            if !page.message.isEmpty {
                Text(page.message)
                    .font(.safet(size: 14, weight: .medium))
                    .foregroundColor(.safetText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if page.hasImage {
                pageImage(page)
            }
            replyRow(page)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.safetSurface)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(page.read ? Color.safetBorder : Color.safetBlue, lineWidth: page.read ? 1 : 1.5)
        )
        .cornerRadius(10)
    }

    @ViewBuilder
    private func pageImage(_ page: PageMessage) -> some View {
        if let data = state.pageImages[page.id], let img = UIImage(data: data) {
            Image(uiImage: img)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 220)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cornerRadius(8)
        } else {
            HStack(spacing: 6) {
                Image(systemName: "photo")
                Text("Loading image…")
            }
            .font(.safet(size: 12, weight: .semibold))
            .foregroundColor(.safetTextDim)
            .onAppear { onEvent(.loadPageImage(page.id)) }
        }
    }

    @ViewBuilder
    private func replyRow(_ page: PageMessage) -> some View {
        if let responded = page.responded {
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle.fill")
                Text("REPLIED: " + responded.uppercased())
            }
            .font(.safet(size: 12, weight: .heavy))
            .foregroundColor(.safetGreen)
        } else {
            HStack(spacing: 8) {
                ForEach(quickReplies, id: \.self) { reply in
                    Button {
                        onEvent(.respondToPage(id: page.id, response: reply))
                    } label: {
                        Text(reply)
                            .font(.safet(size: 12, weight: .bold))
                            .foregroundColor(.safetBlue)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .overlay(Capsule().stroke(Color.safetBlue, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
