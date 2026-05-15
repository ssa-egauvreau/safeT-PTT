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
private val radioApiKeyRaw = localProps.getProperty("radio.api.key")?.trim().orEmpty()

android {
    namespace = "com.securityradio.ptt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.securityradio.ptt"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            val apiUrl = normalizedRadioApiBaseUrl.ifBlank { "http://10.0.2.2:8080/" }
            buildConfigField("String", "API_BASE_URL", "\"${apiUrl.escapeForBuildConfig()}\"")
            buildConfigField("String", "RADIO_API_KEY", "\"${radioApiKeyRaw.escapeForBuildConfig()}\"")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val apiUrl = normalizedRadioApiBaseUrl.ifBlank { "https://CHANGE_ME.up.railway.app/" }
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

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
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
}
