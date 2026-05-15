package com.securityradio.ptt.ui.lcd

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import com.securityradio.ptt.R
import com.securityradio.ptt.ui.theme.RadioLcdPalette

private val LcdFontFamily = FontFamily(
    Font(R.font.roboto_condensed_regular, FontWeight.Normal),
    Font(R.font.roboto_condensed_bold, FontWeight.Bold),
)

private fun tightLineHeight(fontSize: Float) = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

data class LcdTextStyles(
    val status: TextStyle,
    val softKey: TextStyle,
    val zone: TextStyle,
    val channel: TextStyle,
    val body: TextStyle,
    val banner: TextStyle,
)

@Composable
fun rememberLcdTextStyles(palette: RadioLcdPalette): LcdTextStyles {
    return remember(palette.lcdMain, palette.textPrimary, palette.textSecondary, palette.textMuted, palette.textOnButton) {
        LcdTextStyles(
            status = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Normal,
                fontSize = 10.5.sp,
                color = palette.textSecondary,
                lineHeight = 12.sp,
                lineHeightStyle = tightLineHeight(10.5f),
            ),
            softKey = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Bold,
                fontSize = 11.5.sp,
                color = palette.textOnButton,
                lineHeight = 13.sp,
                lineHeightStyle = tightLineHeight(11.5f),
            ),
            zone = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                color = palette.textSecondary,
                lineHeight = 17.sp,
                lineHeightStyle = tightLineHeight(15f),
            ),
            channel = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Bold,
                fontSize = 30.sp,
                color = palette.textPrimary,
                lineHeight = 32.sp,
                lineHeightStyle = tightLineHeight(30f),
            ),
            body = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Normal,
                fontSize = 13.sp,
                color = palette.textSecondary,
                lineHeight = 15.sp,
                lineHeightStyle = tightLineHeight(13f),
            ),
            banner = TextStyle(
                fontFamily = LcdFontFamily,
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
                lineHeight = 16.sp,
                lineHeightStyle = tightLineHeight(14f),
            ),
        )
    }
}
