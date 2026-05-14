pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    // PREFER_SETTINGS: 本 settings 文件声明的仓库优先 (google + mavenCentral),
    // 但用户的 ~/.gradle/init.gradle 加的镜像 (例如 aliyun mirror) 也允许并存.
    // 早期版本用 FAIL_ON_PROJECT_REPOS 严格挡, 但跟国内开发者常配的 init.gradle
    // 镜像加速冲突 — Gradle 直接 InvalidUserCodeException 抛出, 卡死 sync.
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "NinoGameAgent"
include(":app")
