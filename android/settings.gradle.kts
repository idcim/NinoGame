// 国内开发者: 镜像内置 (阿里云 + 腾讯云 + 官方兜底). 不依赖 ~/.gradle/init.gradle.
// 真正卡 sync 的是 pluginManagement (AGP / Kotlin plugin 解析) + Gradle distribution
// zip (~100MB, 走 services.gradle.org 国内可能要小时级); 前者由本文件解决,
// 后者在 gradle/wrapper/gradle-wrapper.properties 切镜像.
//
// 两个 block 都要写 — Gradle DSL 不让 top-level 共享 lambda, 复制是标准写法.

pluginManagement {
    repositories {
        // 阿里云 (国内最稳)
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        // 腾讯云兜底
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
        // 官方最后兜底
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // PREFER_SETTINGS: settings 这里声明的优先, 用户 init.gradle 加的也允许并存,
    // 不抛 InvalidUserCodeException
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
        google()
        mavenCentral()
    }
}

rootProject.name = "NinoGameAgent"
include(":app")
