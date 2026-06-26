// SHARED FILE — compiled into BOTH the SafeTMobile app target (for
// RadioLiveActivityController) and the SafeTMobileLiveActivity extension
// (for ActivityConfiguration). ActivityKit identifies the type by
// unqualified name at runtime; the field order and Codable shape must
// stay identical across the two compiled copies.
import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
struct RadioActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var channel: String
        var callsign: String?
        var stateLabel: String
        // Active transmitter ("UNIT · Name") shown on the Dynamic Island while
        // someone is talking; nil when idle. New fields are appended with `= nil`
        // defaults so the shared Codable shape stays back-compatible and existing
        // ContentState(...) call sites keep compiling.
        var talker: String? = nil
        // Set when the active talker is on a SCANNED channel rather than the
        // tuned one, so the island can show e.g. "SCAN · TAC-2".
        var scanChannel: String? = nil
    }
}
#endif
