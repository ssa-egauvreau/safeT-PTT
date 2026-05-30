import XCTest

/// Confirms both the legacy PTT bar and the big PTT button render based on the
/// SettingsStore launch-arg override.
final class PttControlsRegressionUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func test_bigPtt_on_rendersBigPttControl() {
        let app = XCUIApplication()
        app.launchArguments += ["-uitest-logged-in", "-uitest-big-ptt-on"]
        app.launch()

        let bigPtt = app.otherElements["Push to talk"]
        XCTAssertTrue(bigPtt.waitForExistence(timeout: 5))
        XCTAssertTrue(bigPtt.isHittable)
    }

    func test_bigPtt_off_rendersLegacyPttBar() {
        let app = XCUIApplication()
        app.launchArguments += ["-uitest-logged-in", "-uitest-big-ptt-off"]
        app.launch()

        // CI simulators can take >5 s on cold launch before the legacy PTT bar
        // paints; iteration 1 of this test has flaked with kAXErrorServerNotFound
        // when we bail too early.
        XCTAssertTrue(app.staticTexts["HOLD TO TALK"].waitForExistence(timeout: 15))
    }
}
