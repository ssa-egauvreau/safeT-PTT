package com.securityradio.ptt.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Day / night LCD palettes inspired by public-safety radio displays.
 */
data class RadioLcdPalette(
    val lcdMain: Color,
    val lcdAlt: Color,
    val lcdSection: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    /** Labels on gray control surfaces (soft keys, CH±, PTT idle). */
    val textOnButton: Color,
    val statusGreen: Color,
    val statusAmber: Color,
    val statusEmergency: Color,
    val statusRed: Color,
    val statusBlue: Color,
    /** Scan-receive accent — cyan/teal, deliberately distinct from the amber 10-33 wash and the
     *  blue home-RX highlight so an inverted scan box can't be mistaken for either. */
    val scanRx: Color,
    val rxHighlight: Color,
    val divider: Color,
    val softKeyActiveFill: Color,
    val softKeyInactiveFill: Color,
    val pttIdleFill: Color,
    val pttTransmitFill: Color,
    val pttBusyFill: Color,
    val emergencyFill: Color,
    val materialSurface: Color,
    val materialOnSurface: Color,
    val materialPrimary: Color,
    /** Wash over main LCD while transmitting / busy */
    val txOverlayClear: Color,
    val txOverlayBusy: Color,
) {
    companion object {
        fun day(): RadioLcdPalette = RadioLcdPalette(
            lcdMain = Color(0xFFFFFFFF),
            lcdAlt = Color(0xFFFFFFFF),
            lcdSection = Color(0xFFFFFFFF),
            textPrimary = Color(0xFF3F3F3F),
            textSecondary = Color(0xFF2962CC),
            textMuted = Color(0xFF4478D9),
            textOnButton = Color(0xFFFFFFFF),
            statusGreen = Color(0xFF22B14C),
            statusAmber = Color(0xFFF4B400),
            statusEmergency = Color(0xFFFF5A1F),
            statusRed = Color(0xFFD32F2F),
            statusBlue = Color(0xFF2B6DFF),
            scanRx = Color(0xFF0AA5B8),
            rxHighlight = Color(0xFF2B6DFF),
            divider = Color(0xFFC8C8C8),
            softKeyActiveFill = Color(0xFF646464),
            softKeyInactiveFill = Color(0xFF646464),
            pttIdleFill = Color(0xFF646464),
            pttTransmitFill = Color(0xFF22B14C),
            pttBusyFill = Color(0xFF646464),
            emergencyFill = Color(0xFF646464),
            materialSurface = Color(0xFFFFFFFF),
            materialOnSurface = Color(0xFF3F3F3F),
            materialPrimary = Color(0xFF2B6DFF),
            txOverlayClear = Color(0xFF22B14C),
            txOverlayBusy = Color(0xFFD32F2F),
        )

        /** Black / grey / dark blue tactical night LCD (minimal green tint). */
        fun night(): RadioLcdPalette = RadioLcdPalette(
            lcdMain = Color(0xFF05070B),
            lcdAlt = Color(0xFF0A1018),
            lcdSection = Color(0xFF101722),
            textPrimary = Color(0xFFC5D4E8),
            textSecondary = Color(0xFF8FA9C4),
            textMuted = Color(0xFF5C6F8A),
            textOnButton = Color(0xFFE8EEF9),
            statusGreen = Color(0xFF4ADE80),
            statusAmber = Color(0xFFFFC048),
            statusEmergency = Color(0xFFFF6B42),
            statusRed = Color(0xFFFF5252),
            statusBlue = Color(0xFF5B9FFF),
            scanRx = Color(0xFF2BE0F0),
            rxHighlight = Color(0xFF5B9FFF),
            divider = Color(0xFF1E2A38),
            softKeyActiveFill = Color(0xFF253044),
            softKeyInactiveFill = Color(0xFF182230),
            pttIdleFill = Color(0xFF161E2C),
            pttTransmitFill = Color(0xFF4ADE80),
            pttBusyFill = Color(0xFFFF5252),
            emergencyFill = Color(0xFFCC4A29),
            materialSurface = Color(0xFF101722),
            materialOnSurface = Color(0xFFC5D4E8),
            materialPrimary = Color(0xFF5B9FFF),
            txOverlayClear = Color(0xFF4ADE80),
            txOverlayBusy = Color(0xFFFF5252),
        )
    }
}
