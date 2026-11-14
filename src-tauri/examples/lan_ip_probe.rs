// 验收探针（不提交）：验证检测函数在真实多网卡环境返回可达 WLAN 地址。
fn main() {
    println!("detect_lan_ip = {:?}", task_dock_lib::mobile_sync::detect_lan_ip());
}
