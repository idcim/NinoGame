// 仓库 + 镜像声明 — 镜像在前, 官方在后兜底.
// 国内开发者不依赖 ~/.gradle/init.gradle 即可加速 (重要: 真正卡的不是仓库依赖,
// 是 Gradle plugin 解析 + AGP 元数据 + Compose BOM 元数据这些 jcenter/google CDN
// 的小文件, init.gradle 的 allprojects { repositories } 加不进 pluginManagement,
// 所以写到 settings 这里才真正生效).
val mirrorRepos: org.gradle.api.artifacts.dsl.RepositoryHandler.() -> Unit = {
    // 阿里云镜像 (国内最稳, 同步及时)
    maven { url = uri("https://maven.aliyun.com/repository/google") }
    maven { url = uri("https://maven.aliyun.com/repository/central") }
    maven { url = uri("https://maven.aliyun.com/repository/public") }
    maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
    // 腾讯云兜底 (有时阿里云某个包没同步, 腾讯刚好有)
    maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
    // 官方最后兜底 — 防止极少数包镜像没收录
    google()
    mavenCentral()
    gradlePluginPortal()
}

pluginManagement {
    repositories { mirrorRepos() }
}

dependencyResolutionManagement {
    // PREFER_SETTINGS: settings 这里声明的优先, 用户 init.gradle 加的也允许 (并存),
    // 不抛 InvalidUserCodeException
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories { mirrorRepos() }
}

rootProject.name = "NinoGameAgent"
include(":app")
