plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.ninogame.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ninogame.agent"
        // minSdk 24 (Android 7.0 / Nougat 2016) — 老平板能用; AccessibilityService
        // / Compose / OkHttp 都支持. 再低就要回退 AppCompat, 不划算.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.5.0"
        // 平板 + 大屏不限制 — Android 8+ 默认全屏寸适配
        resourceConfigurations += listOf("zh", "en")
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        getByName("debug") {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
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
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    // AndroidX 基础
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")

    // Material Components — 提供 XML 主题 parent (Theme.Material3.DayNight.NoActionBar
    // 等). Compose material3 是 Kotlin 部分, 不带 XML 资源; Activity 的 android:theme
    // 在 Compose 加载前还要靠 XML 主题做窗口背景 + 状态栏色, 因此这个库要装.
    implementation("com.google.android.material:material:1.12.0")

    // Compose BOM — 一行管多版本
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // WindowSizeClass — 平板 / 大屏 / 折叠屏自适应
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Navigation Compose — 多页面切 (PairScreen → DashboardScreen)
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // DataStore Preferences — 取代 SharedPreferences, 协程友好, agent_token /
    // device_id / child_id / backend_url 都存这里
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // OkHttp 4.12 — HTTP + WebSocket. 5.x 改了 API, 老资料多按 4 系列写, 先稳
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // kotlinx.serialization — JSON 编解码. 比 Gson/Moshi 轻量, Kotlin 原生
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // 协程
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // 测试 (skeleton 现阶段不写测试, 留依赖位置)
    testImplementation("junit:junit:4.13.2")
}
