# ProGuard rules for KEDAI KHANXA Android App
# Keep Kotlin coroutines, Firebase, Google Credential Manager, and ML Kit metadata.

-keepattributes Signature
-keepattributes *Annotation*

-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

-keepclassmembers class com.kedaikhanxa.app.model.** {
    *;
}
