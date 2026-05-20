# Proguard / R8 rules for the safeT PTT radio app.
#
# The release build runs with `isMinifyEnabled = true`, which strips and
# obfuscates the bytecode for everything below. Anything reachable only via
# reflection (Retrofit interfaces, Gson DTO fields, JNI callbacks, etc.) must
# be explicitly kept here or it will be silently renamed/removed at build time
# and crash at runtime.
#
# Rules are intentionally generous — voice-radio reliability is more important
# than squeezing every last byte out of the APK. The minifier still does its
# job on the Compose tree, ViewModels, presentation glue, and helpers (most of
# the code), which is where the bulk of the size savings come from.

# ---------- Retrofit ---------------------------------------------------------
# Retrofit reads HTTP-verb annotations off the API interfaces at runtime via
# reflection. Without these the interface methods get renamed and Retrofit can
# no longer find the request descriptors.
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes Exceptions
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response

-keepclasseswithmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}

# The app's API interfaces — Retrofit creates dynamic proxies over these.
-keep interface com.securityradio.ptt.data.remote.AuthApi { *; }
-keep interface com.securityradio.ptt.data.remote.ChannelsApi { *; }
-keep interface com.securityradio.ptt.data.remote.RadioApi { *; }

# ---------- Gson ------------------------------------------------------------
# Gson reflects DTO classes by name. Keep all the data/remote DTOs (they're
# defined as `data class ...Dto` and used both for request bodies and response
# parsing) — losing a field name to obfuscation silently produces null fields.
-keep class com.securityradio.ptt.data.remote.** { *; }

# Gson's own reflection-heavy types.
-keep class com.google.gson.** { *; }
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# ---------- OkHttp ----------------------------------------------------------
# OkHttp's optional dependencies declare types it uses reflectively for
# certificate pinning, BouncyCastle fallback, etc. Suppress the warnings.
-dontwarn okhttp3.internal.**
-dontwarn okio.**
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# ---------- JNI (P25 IMBE vocoder) ------------------------------------------
# JNI lookups happen by mangled class+method name. R8 renaming the holder
# object or its native methods would mean the .so can no longer link against
# them at load time — voice would silently fall back to clear PCM.
-keep class com.securityradio.ptt.device.P25ImbeNative { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# ---------- Compose ---------------------------------------------------------
# Compose's own consumer rules (shipped by androidx.compose) cover the runtime
# and tooling-preview wiring. Keep our @Composable functions' signatures stable
# so any reflective tooling (e.g. preview) keeps working in release builds.
-keep,allowobfuscation @interface androidx.compose.runtime.Composable
-keep @androidx.compose.runtime.Composable class * { *; }

# ---------- Kotlin metadata + coroutines ------------------------------------
# Kotlin reflection / lookup tools consult @Metadata. Coroutines emit
# inner classes that R8 sometimes over-prunes.
-keep class kotlin.Metadata { *; }
-keepclassmembers class kotlin.coroutines.jvm.internal.BaseContinuationImpl {
    <fields>;
}
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }

# ---------- Application-level keeps -----------------------------------------
# Sealed event hierarchies are touched by Kotlin's reified `is` checks and
# Compose recomposition; sealed subclasses must keep stable names. The `$**`
# globs catch nested sealed members recursively. UiState data classes get the
# same treatment so the unused-field shrinker doesn't drop a UI field that's
# only consumed by a Composable's destructuring `copy()`.
-keep class com.securityradio.ptt.presentation.RadioUiEvent { *; }
-keep class com.securityradio.ptt.presentation.RadioUiEvent$** { *; }
-keep class com.securityradio.ptt.presentation.RadioUiState { *; }
-keep class com.securityradio.ptt.device.HardwareButtonEvent { *; }
-keep class com.securityradio.ptt.device.HardwareButtonEvent$** { *; }

# Suppress benign warnings from libraries that probe for optional deps.
-dontwarn javax.annotation.**
-dontwarn javax.lang.model.**
-dontwarn java.lang.invoke.**
