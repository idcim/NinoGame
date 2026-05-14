# NinoGame Agent — release shrink/obfuscate 规则.
#
# kotlinx.serialization 需要保留 @Serializable class 的伴生对象 + 字段 metadata,
# 不保会被混淆到运行时 NoSuchField. 标准做法:

-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# 项目内 @Serializable data class — 自动按 package 保, 防止 release 混淆字段名
-keep class com.ninogame.agent.net.** { *; }
-keep class com.ninogame.agent.data.** { *; }

# OkHttp 自带 proguard rules, 不用额外加 (kotlinx.coroutines 同).
