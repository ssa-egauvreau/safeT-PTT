import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

private fun loadLocalProperties(rootDir: java.io.File): Properties {
    val props = Properties()
    val file = rootDir.resolve("local.properties")
    if (file.isFile) {
        file.inputStream().use { props.load(it) }
    }
    return props
}

private fun String.escapeForBuildConfig(): String =
    this.replace("\\", "\\\\").replace("\"", "\\\"")

private val localProps = loadLocalProperties(rootProject.rootDir)
private val radioApiBaseUrlRaw = localProps.getProperty("radio.api.base.url")?.trim().orEmpty()
private val normalizedRadioApiBaseUrl: String = when {
    radioApiBaseUrlRaw.isEmpty() -> ""
    radioApiBaseUrlRaw.endsWith("/") -> radioApiBaseUrlRaw
    else -> "$radioApiBaseUrlRaw/"
}
/**
 * Default backend when [radio.api.base.url] is not set in local.properties.
 * Override per machine with local.properties — never commit secrets there.
 */
private val defaultRailwayApiBaseUrl = "https://safet-ptt.com/"
private val radioApiKeyRaw = localProps.getProperty("radio.api.key")?.trim().orEmpty()

// CI bumps these per build (env) so each OTA build advertises a higher code; local builds use the
// committed defaults.
private val buildVersionCode: Int = System.getenv("APP_VERSION_CODE")?.trim()?.toIntOrNull() ?: 1
private val buildVersionName: String =
    System.getenv("APP_VERSION_NAME")?.trim()?.ifEmpty { null } ?: "0.1.0"

// Release signing comes from CI secrets (keystore decoded to a file, passwords in env). When absent
// — e.g. a local `assembleRelease` — the release build falls back to the committed debug key.
private val releaseKeystorePath: String = System.getenv("RELEASE_KEYSTORE_PATH")?.trim().orEmpty()
private val hasReleaseKeystore: Boolean =
    releaseKeystorePath.isNotEmpty() && File(releaseKeystorePath).isFile

android {
    namespace = "com.securityradio.ptt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.securityradio.ptt"
        /** Sonim XP6-class devices ship Android 7.x (API 24–25); keep min low enough to install there. */
        minSdk = 21
        targetSdk = 35
        versionCode = buildVersionCode
        versionName = buildVersionName

        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
        }

        externalNativeBuild {
            cmake {
                // libc++ must be linked for C++ ABI (operators, mutex, exceptions). ANDROID_STL=c++_static
                // drove only -static-libstdc++, which breaks NDK/clang linkage; see C++ STL guide.
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    // A stable debug keystore is committed in app/debug.keystore so every build
    // — local or CI — signs APKs with the same key. Sideloaded fleet APKs can
    // then update over previous installs without an uninstall, the way a Play
    // Store update would. For Play Store distribution use a separate, real
    // release signing key.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("RELEASE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // Optional shared secret (not from any third-party site): if RADIO_API_KEY is set on the
            // server, add the same value as radio.api.key in local.properties — otherwise empty is fine.
            val apiUrl = normalizedRadioApiBaseUrl.ifBlank { defaultRailwayApiBaseUrl }
            buildConfigField("String", "API_BASE_URL", "\"${apiUrl.escapeForBuildConfig()}\"")
            buildConfigField("String", "RADIO_API_KEY", "\"${radioApiKeyRaw.escapeForBuildConfig()}\"")
        }
        release {
            signingConfig =
                if (hasReleaseKeystore) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
            // R8 + resource shrinking — see app/proguard-rules.pro for the keep rules covering
            // Retrofit interfaces, Gson DTOs, the P25 JNI bridge, sealed event hierarchies, etc.
            // Compose / OkHttp / kotlinx.coroutines ship their own consumer rules.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val apiUrl = normalizedRadioApiBaseUrl.ifBlank { defaultRailwayApiBaseUrl }
            buildConfigField("String", "API_BASE_URL", "\"${apiUrl.escapeForBuildConfig()}\"")
            buildConfigField("String", "RADIO_API_KEY", "\"${radioApiKeyRaw.escapeForBuildConfig()}\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    androidResources {
        // openWakeWord TFLite models must be memory-mappable (openFd), so keep them uncompressed.
        noCompress += "tflite"
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }

    packaging {
        resources {
            excludes.add("/META-INF/AL2.0")
            excludes.add("/META-INF/LGPL2.1")
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("com.google.android.material:material:1.12.0")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // On-device wake-word spotter (openWakeWord TFLite models). Inference is gated behind a
    // disabled-by-default flag and self-disables when the model assets are absent, so this only
    // adds the runtime; it does nothing until a trained model is shipped.
    implementation("org.tensorflow:tensorflow-lite:2.16.1")
}
