import SwiftUI
import WidgetKit

// MARK: - Entry

struct RadioWidgetEntry: TimelineEntry {
    let date: Date
    let channelName: String
    let usersCount: Int
    let statusLabel: String
}

// MARK: - Provider

struct RadioWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> RadioWidgetEntry {
        RadioWidgetEntry(date: Date(), channelName: "ALPHA-1", usersCount: 4, statusLabel: "IDLE")
    }

    func getSnapshot(in context: Context, completion: @escaping (RadioWidgetEntry) -> Void) {
        completion(currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RadioWidgetEntry>) -> Void) {
        let entry = currentEntry()
        let next = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private func currentEntry() -> RadioWidgetEntry {
        let d = UserDefaults(suiteName: "group.com.safetptt.mobile") ?? .standard
        return RadioWidgetEntry(
            date: Date(),
            channelName: d.string(forKey: "widget.channelName") ?? "----",
            usersCount: d.integer(forKey: "widget.usersCount"),
            statusLabel: d.string(forKey: "widget.statusLabel") ?? "OFFLINE"
        )
    }
}

// MARK: - View

struct RadioWidgetView: View {
    var entry: RadioWidgetEntry
    @Environment(\.widgetFamily) var family

    private var statusColor: Color {
        switch entry.statusLabel {
        case "TX": return .safetGreen
        case "RX": return .safetSignal
        case "OFFLINE": return .safetAmber
        default: return .safetTextDim
        }
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            circularView
        case .accessoryRectangular:
            rectangularView
        case .systemMedium:
            mediumView
                .containerBackground(Color.safetBackground, for: .widget)
        default:
            smallView
                .containerBackground(Color.safetBackground, for: .widget)
        }
    }

    // MARK: Home screen — small

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.safetBlue)
                Spacer()
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .padding(.top, 3)
            }
            Spacer()
            Text(entry.channelName)
                .font(.system(size: 15, weight: .bold, design: .monospaced))
                .foregroundColor(.safetText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HStack(spacing: 6) {
                Text(entry.statusLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusColor)
                Text("\(entry.usersCount) online")
                    .font(.system(size: 10))
                    .foregroundColor(.safetTextDim)
            }
            .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(URL(string: "safet://radio"))
    }

    // MARK: Home screen — medium

    private var mediumView: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.safetBlue)
                    Text("safeT PTT")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.safetTextDim)
                }
                Text(entry.channelName)
                    .font(.system(size: 20, weight: .bold, design: .monospaced))
                    .foregroundColor(.safetText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 4) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.safetTextDim)
                    Text("\(entry.usersCount) unit\(entry.usersCount == 1 ? "" : "s") online")
                        .font(.system(size: 11))
                        .foregroundColor(.safetTextDim)
                }
            }
            Spacer()
            VStack(spacing: 10) {
                statusPill
                Text("Open Radio")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.safetBlue)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .widgetURL(URL(string: "safet://radio"))
    }

    // MARK: Lock screen — rectangular

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 10, weight: .bold))
                Text(entry.channelName)
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundColor(.white)
            HStack(spacing: 6) {
                Text(entry.statusLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusColor)
                Text("·")
                    .font(.system(size: 10))
                    .foregroundColor(.gray)
                Text("\(entry.usersCount) online")
                    .font(.system(size: 10))
                    .foregroundColor(.gray)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "safet://radio"))
    }

    // MARK: Lock screen — circular

    private var circularView: some View {
        VStack(spacing: 2) {
            Image(systemName: statusSystemImage)
                .font(.system(size: 14, weight: .bold))
            Text(entry.statusLabel.prefix(2))
                .font(.system(size: 9, weight: .bold))
        }
        .foregroundColor(statusColor)
        .widgetURL(URL(string: "safet://radio"))
    }

    // MARK: Helpers

    private var statusPill: some View {
        Text(entry.statusLabel)
            .font(.system(size: 11, weight: .bold))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(statusColor.opacity(0.18))
            .foregroundColor(statusColor)
            .clipShape(Capsule())
    }

    private var statusSystemImage: String {
        switch entry.statusLabel {
        case "TX": return "dot.radiowaves.left.and.right"
        case "RX": return "antenna.radiowaves.left.and.right"
        default: return "antenna.radiowaves.left.and.right.slash"
        }
    }
}

// MARK: - Widget

struct RadioWidget: Widget {
    let kind = "RadioWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RadioWidgetProvider()) { entry in
            RadioWidgetView(entry: entry)
        }
        .configurationDisplayName("safeT Radio")
        .description("Shows your active channel, connected units, and TX/RX status.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular
        ])
    }
}
