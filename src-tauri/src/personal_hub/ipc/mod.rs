//! 本地管理 IPC：仅 Windows Named Pipe（当前用户 ACL + 拒绝远程客户端）。
//! 不提供 HTTP/TCP 监听，不存在公网网卡绑定。

pub mod named_pipe;

pub use named_pipe::{pipe_request, NamedPipeServer, PipeHandler, PipeHealth};
