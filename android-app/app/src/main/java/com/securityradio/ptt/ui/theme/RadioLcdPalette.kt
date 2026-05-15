package com.securityradio.ptt.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Day / night LCD palettes inspired by public-safety radio displays.
 * Values are generic recreations for Sunset Safety Agency branding only.
 */
data class RadioLcdPalette(
    val lcdMain: Color,
    val lcdAlt: Color,
    val lcdSection: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    /** Labels on #646464 (or other dark) control surfaces (soft keys, CH±, PTT idle). */
    val textOnButton: Color,
    val statusGreen: Color,
    val statusAmber: Color,
    val statusEmergency: Color,
    val statusBlue: Color,
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
) {
    companion object {
        fun day(): RadioLcdPalette = RadioLcdPalette(
            lcdMain = Color(0xFFFFFFFF),
            lcdAlt = Color(0xFFFFFFFF),
            lcdSection = Color(0xFFFFFFFF),
            textPrimary = Color(0xFF3F3F3F),
            textSecondary = Color(0xFF3F3F3F),
            textMuted = Color(0xFF6A6A6A),
            textOnButton = Color(0xFFFFFFFF),
            statusGreen = Color(0xFF22B14C),
            statusAmber = Color(0xFFF4B400),
            statusEmergency = Color(0xFFFF5A1F),
            statusBlue = Color(0xFF2B6DFF),
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
        )

        fun night(): RadioLcdPalette = RadioLcdPalette(
            lcdMain = Color(0xFF0D1114),
            lcdAlt = Color(0xFF151A1E),
            lcdSection = Color(0xFF1B2126),
            textPrimary = Color(0xFFD8F3D0),
            textSecondary = Color(0xFFA8C7A2),
            textMuted = Color(0xFF6E8A73),
            textOnButton = Color(0xFFD8F3D0),
            statusGreen = Color(0xFF3CFF6A),
            statusAmber = Color(0xFFFFC940),
            statusEmergency = Color(0xFFFF6430),
            statusBlue = Color(0xFF58A6FF),
            divider = Color(0xFF2E383F),
            softKeyActiveFill = Color(0xFF232C33),
            softKeyInactiveFill = Color(0xFF1B2126),
            pttIdleFill = Color(0xFF151A1E),
            pttTransmitFill = Color(0xFF3CFF6A),
            pttBusyFill = Color(0xFFFFC940),
            emergencyFill = Color(0xFFFF6430),
            materialSurface = Color(0xFF1B2126),
            materialOnSurface = Color(0xFFD8F3D0),
            materialPrimary = Color(0xFF58A6FF),
        )
    }
}
