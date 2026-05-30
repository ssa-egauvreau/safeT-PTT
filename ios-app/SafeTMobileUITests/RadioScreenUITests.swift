import XCTest

/// Smoke tests for the safeT Mobile shell. The default launch shows the login
/// screen; passing `-uitest-logged-in` bootstraps a fake AuthSession so the
/// radio shell can be asserted without a real server.
final class RadioScreenUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - login screen (default launch)

    func test_login_showsCredentialFields_andSignInButton() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.staticTexts["safeT"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["USERNAME"].exists)
        XCTAssertTrue(app.staticTexts["PASSWORD"].exists)
        XCTAssertTrue(app.buttons["SIGN IN"].exists)
    }

    // MARK: - radio shell (forced sign-in)

    func test_radio_launchesAndShowsCoreControls() {
        let app = XCUIApplication()
        // Force the legacy PTT bar so HOLD TO TALK is rendered (the big PTT
        // button has its own coverage in PttControlsRegressionUITests).
        app.launchArguments += ["-uitest-logged-in", "-uitest-big-ptt-off"]
        app.launch()

        // Status strip shows the stubbed unit id.
        XCTAssertTrue(app.staticTexts["UNIT UITEST"].waitForExistence(timeout: 5))

        // The PTT bar shows HOLD TO TALK in the idle state.
        XCTAssertTrue(app.staticTexts["HOLD TO TALK"].exists)

        // The emergency button is always rendered in the idle layout. SwiftUI
        // exposes a `Button { ... } label: { Text(...) }` as a button (with the
        // Text as its accessibility label), not as a separate staticText.
        XCTAssertTrue(app.buttons["EMERGENCY"].exists)

        // Settings tab is always visible in the icon-only tab strip (its
        // accessibilityLabel is "SETTINGS"). Sign-out now lives inside it.
        XCTAssertTrue(app.buttons["SETTINGS"].exists)
    }

    func test_radio_signOut_returnsToLogin() throws {
        let app = XCUIApplication()
        // Force the legacy PTT bar so this test exercises the navigation
        // path without contending with the bottom-trailing BigPttButton
        // overlay. The big-PTT layout is covered separately by
        // PttControlsRegressionUITests.
        app.launchArguments += ["-uitest-logged-in", "-uitest-big-ptt-off"]
        app.launch()

        let settings = app.buttons["SETTINGS"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()

        XCTAssertTrue(app.navigationBars["SETTINGS"].waitForExistence(timeout: 5),
                      "SETTINGS sheet did not present")

        // Sign Out lives at the bottom of a tall grouped list (Account,
        // Controls, Scan, Location, About). CI simulators don't auto-scroll
        // it into the accessibility tree until we swipe.
        let openConfirm = app.buttons["Sign Out…"]
        XCTAssertTrue(scrollUntilVisible(openConfirm, in: app, maxSwipes: 8),
                      "Sign Out… not found in SETTINGS sheet")
        openConfirm.tap()

        let confirm = app.buttons["Sign Out"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()

        XCTAssertTrue(app.buttons["SIGN IN"].waitForExistence(timeout: 5))
    }

    /// Swipe up until `element` appears in the accessibility tree (or give up).
    private func scrollUntilVisible(_ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int) -> Bool {
        for _ in 0..<maxSwipes {
            if element.waitForExistence(timeout: 1) { return true }
            app.swipeUp()
        }
        return element.waitForExistence(timeout: 2)
    }
}
