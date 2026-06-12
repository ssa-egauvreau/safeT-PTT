import XCTest

/// Confirms the press-and-hold PTT bar renders in the idle radio shell. (The
/// optional large on-screen PTT button was removed — the bar is now the only
/// on-screen PTT control.)
final class PttControlsRegressionUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func test_pttBar_rendersHoldToTalk() {
        let app = XCUIApplication()
        app.launchArguments += ["-uitest-logged-in"]
        app.launch()

        // CI simulators can take >5 s on cold launch before the PTT bar paints;
        // give it a generous window so iteration 1 doesn't flake.
        XCTAssertTrue(app.staticTexts["HOLD TO TALK"].waitForExistence(timeout: 15))
    }
}
