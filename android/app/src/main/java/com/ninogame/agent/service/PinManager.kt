package com.ninogame.agent.service

import android.content.Context
import android.util.Log
import com.ninogame.agent.data.Settings
import kotlinx.coroutines.flow.first
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** PIN 管理 — 跟 Windows agent protector/pin_manager.py 完全同算法:
 *
 *  - PBKDF2-SHA256, 16 字节 salt, 240000 iter, output 32 bytes = 64 hex chars
 *  - 3 次错误锁定 30 分钟 (CLAUDE.md §3.3)
 *  - 同 hash 可在两端互验 — 家长后台设 PIN 推 set_pin command, Android 验证
 *    跟 Windows agent 算出来的 hash 相同, 行为一致
 *
 *  存储: data/Settings DataStore (K_PIN_HASH / K_PIN_SALT / K_PIN_FAIL_COUNT /
 *  K_PIN_LOCKED_UNTIL_MS), 不持久化到磁盘文件 — 卸载 App 即清.
 */
object PinManager {

    private const val TAG = "PinManager"
    private const val ITERATIONS = 240_000
    private const val KEY_LENGTH_BITS = 256  // 32 bytes
    private const val SALT_BYTES = 16
    private const val ALGORITHM = "PBKDF2WithHmacSHA256"
    private const val MAX_FAILS_BEFORE_LOCK = 3
    private const val LOCK_DURATION_MS = 30 * 60 * 1000L  // 30 分钟

    private fun hash(pin: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, ITERATIONS, KEY_LENGTH_BITS)
        val factory = SecretKeyFactory.getInstance(ALGORITHM)
        return factory.generateSecret(spec).encoded
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun String.fromHex(): ByteArray {
        val len = length
        if (len % 2 != 0) throw IllegalArgumentException("odd hex length")
        return ByteArray(len / 2) { i ->
            ((Character.digit(this[i * 2], 16) shl 4) or
                Character.digit(this[i * 2 + 1], 16)).toByte()
        }
    }

    /** server 推 set_pin command 时调. PIN ≥ 4 位才接受 (跟 Windows 一致). */
    suspend fun setPin(ctx: Context, newPin: String): Boolean {
        if (newPin.length < 4) {
            Log.w(TAG, "setPin: PIN <4 位, 拒绝")
            return false
        }
        val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        val h = hash(newPin, salt)
        Settings.from(ctx).savePin(h.toHex(), salt.toHex())
        Log.i(TAG, "★ PIN 已设置 (hash 64-hex 跟 Windows pin_manager.py 完全同源)")
        return true
    }

    suspend fun clearPin(ctx: Context) {
        Settings.from(ctx).clearPin()
        Log.i(TAG, "★ PIN 已清空")
    }

    /** v0.5.27+ 查 PIN 是否已设. AgentService.sendHello 用来上报 server,
     *  让家长后台能看到"哪些设备还没设 PIN". */
    suspend fun isPinSet(ctx: Context): Boolean {
        val s = Settings.from(ctx)
        return s.pinHash.first() != null && s.pinSalt.first() != null
    }

    /** v0.5.27+ 从 server 同步 PIN — 跳过自己 hash, 直接存 server 给的
     *  hash + salt. 跟 setPin 同算法 (PBKDF2-SHA256 32B / salt 16B / iter 240000),
     *  server services/parent_pin.ts 对齐. 校验 hex 长度防错误 payload 写坏本地. */
    suspend fun setPinRaw(ctx: Context, hashHex: String, saltHex: String): Boolean {
        if (hashHex.length != 64 || !hashHex.all { it in "0123456789abcdefABCDEF" }) {
            Log.w(TAG, "setPinRaw: hashHex 不合法 (期望 64 hex)")
            return false
        }
        if (saltHex.length != SALT_BYTES * 2 || !saltHex.all { it in "0123456789abcdefABCDEF" }) {
            Log.w(TAG, "setPinRaw: saltHex 不合法 (期望 ${SALT_BYTES * 2} hex)")
            return false
        }
        Settings.from(ctx).savePin(hashHex.lowercase(), saltHex.lowercase())
        Log.i(TAG, "★ PIN 从 server 同步 (hash=${hashHex.take(8)}..., salt=${saltHex.take(8)}...)")
        return true
    }

    /** 验证 PIN. 锁定期内直接返 NotSet 不接受验证. */
    suspend fun verify(ctx: Context, pin: String): VerifyResult {
        val s = Settings.from(ctx)
        val lockedUntil = s.pinLockedUntilMs.first()
        if (lockedUntil != null && lockedUntil > System.currentTimeMillis()) {
            val remainingMin = ((lockedUntil - System.currentTimeMillis()) / 60_000L).toInt() + 1
            return VerifyResult.Locked(remainingMin)
        }
        // 锁定到期或没锁: 接受验证
        val hashHex = s.pinHash.first() ?: return VerifyResult.NotSet
        val saltHex = s.pinSalt.first() ?: return VerifyResult.NotSet
        val salt = runCatching { saltHex.fromHex() }.getOrNull() ?: return VerifyResult.NotSet
        val attemptHex = hash(pin, salt).toHex()
        val ok = constantTimeEquals(attemptHex, hashHex)
        return if (ok) {
            s.resetPinFails()
            VerifyResult.Ok
        } else {
            val (count, lockedTo) = s.bumpPinFail(MAX_FAILS_BEFORE_LOCK, LOCK_DURATION_MS)
            if (lockedTo != null) {
                Log.w(TAG, "PIN 错 $count 次, 锁定 ${LOCK_DURATION_MS / 60_000} 分钟")
                VerifyResult.Locked(30)
            } else {
                VerifyResult.Fail(MAX_FAILS_BEFORE_LOCK - count)
            }
        }
    }

    sealed interface VerifyResult {
        data object Ok : VerifyResult
        data object NotSet : VerifyResult
        data class Fail(val remainingAttempts: Int) : VerifyResult
        data class Locked(val remainingMinutes: Int) : VerifyResult
    }

    /** 常数时间比较, 防 timing attack (跟 Windows secrets.compare_digest 等价). */
    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var r = 0
        for (i in a.indices) r = r or (a[i].code xor b[i].code)
        return r == 0
    }
}
