# host-relay-agent

这是 `host-relay` 项目的常驻客户端（Agent）程序。
它由 Go 语言编写，编译后为一个无依赖的单文件静态二进制程序。主要职责是向服务端的 Cloudflare Worker 定期上报本机状态（CPU、内存、磁盘、外网/局域网 IP），并通过反向 WebSocket 隧道建立和暴露本机的 SSH 服务给网页端管理。

## 目录说明

- `main.go`：客户端的核心逻辑源码。
- `build.sh`：跨平台一键编译脚本。

## 编译方法

客户端使用 Go 语言开发，支持多平台交叉编译。你可以直接运行 `build.sh` 脚本进行一键编译：

```bash
cd src/agent
chmod +x build.sh
./build.sh
```

编译完成后，会在当前目录下生成一个 `out/` 文件夹，里面包含了 Linux、macOS、Windows 各个架构的可执行文件。

## 命令行参数说明

在目标机器上运行 agent 时，你可以通过以下命令行参数进行配置：

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--server` | ✅ 是 | 无 | 你的 Cloudflare Worker 服务端地址，必须以 `wss://` (或 `ws://`) 开头。 |
| `--id` | ✅ 是 | 无 | 面板分配给该主机的唯一 ID（如 `h_1a2b3c`）。 |
| `--token` | ✅ 是 | 无 | 面板生成的注册令牌（只显示一次），用于安全绑定。 |
| `--ssh-target` | ❌ 否 | `127.0.0.1:22` | 允许网页端连接的本地 SSH 目标地址，相当于白名单限制。 |
| `--ssh-key` | ❌ 否 | 无 | 极其安全的**私钥免密认证**方式。指定目标机上的一个私钥文件路径（如 `/root/.ssh/id_rsa`）。在网页端选择“私钥”登录时，Agent 会直接用这个文件进行认证，私钥内容绝不经过网络。 |
| `--interval` | ❌ 否 | `30s` | 状态（CPU/内存等）的上报间隔时间。 |
| `--disk-path` | ❌ 否 | `/` (Win为 `C:\`) | 用于统计磁盘用量的路径。 |

## 运行示例

### 1. 标准运行（密码登录）
当你不需要私钥登录，准备直接在网页上输入密码时：
```bash
./agent --server wss://your-domain.com --id h_12345 --token tk_abcde
```

### 2. 高级运行（私钥免密登录）
当你希望最高级别的安全，不在网页上敲密码，而是让 Agent 在本地验证私钥时：
```bash
./agent --server wss://your-domain.com --id h_12345 --token tk_abcde --ssh-key /root/.ssh/id_rsa
```

### 3. 修改被监控的磁盘路径
例如监控一台挂载了 `/data` 目录 NAS：
```bash
./agent --server wss://your-domain.com --id h_12345 --token tk_abcde --disk-path /data
```

## 进程守护 (Systemd)

为了让 Agent 在 Linux 主机上能够开机自启并常驻后台，建议使用 Systemd 进行守护。

1. 创建服务文件：`sudo nano /etc/systemd/system/host-relay.service`
2. 填入以下内容（请替换为你自己的路径和参数）：
```ini
[Unit]
Description=Host Relay Agent
After=network.target

[Service]
Type=simple
# 替换为你的真实 agent 存放路径和启动参数
ExecStart=/opt/host-relay/agent-linux-amd64 --server wss://your-domain.com --id h_xxxxx --token tk_xxxxx
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
```
3. 启动并设置开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable host-relay
sudo systemctl start host-relay
sudo systemctl status host-relay
```
