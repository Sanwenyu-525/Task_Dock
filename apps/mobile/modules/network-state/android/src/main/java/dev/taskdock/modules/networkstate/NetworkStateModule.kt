// 网络计费状态（Android）：只回答「当前活动网络是否计费」，不做常驻监听。
//
// 安全/隐私边界：
// - 只读 NetworkCapabilities，不采集 SSID、运营商、IP、流量统计；
// - 不写日志；
// - 无法判定（无活动网络、无 NETWORK_STATE 权限、能力位缺失）一律返回 null，
//   由 JS 侧 fail-closed 处理，绝不默认「不计费」。
package dev.taskdock.modules.networkstate

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NetworkStateModule : Module() {
  private fun unknown(): Map<String, Any?> = mapOf("metered" to null, "type" to "unknown")

  private fun typeOf(capabilities: NetworkCapabilities): String {
    return when {
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      else -> "unknown"
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NetworkState")

    Function("getNetworkState") {
      val context = appContext.reactContext ?: return@Function unknown()
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return@Function unknown()
      try {
        val network = manager.activeNetwork ?: return@Function mapOf("metered" to null, "type" to "none")
        val capabilities = manager.getNetworkCapabilities(network) ?: return@Function unknown()
        val metered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        mapOf("metered" to metered, "type" to typeOf(capabilities))
      } catch (_: SecurityException) {
        unknown()
      } catch (_: RuntimeException) {
        unknown()
      }
    }
  }
}
