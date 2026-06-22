# host-relay

基于 Cloudflare Workers 免费额度的轻量主机管理面板。客户端 Agent 常驻后台上报状态，通过 Cloudflare 的 WebSocket 反向中继（类似 frp 模型）实现无需公网 IP 的网页 SSH 访问。

> **核心目标**: 全程不超出 Cloudflare 免费额度，服务端采用极简的单文件 `worker.js` 设计，一键复制即可部署，个人 homelab 管理利器。

## 目录结构
```text
├── docs/
│   └── design.md       # 详细的技术架构设计文档
├── src/
│   ├── agent/          # Go 语言客户端源码 (数据采集与反向 SSH)
│   │   ├── build.sh    # 跨平台一键编译脚本
│   │   └── main.go
│   └── worker/         # Cloudflare Worker 服务端源码
│       ├── worker.js   # 包含面板 HTML、业务逻辑及 Durable Objects 的单文件
│       └── wrangler.toml
└── readme.md           # 本说明文件
```

---

## 一、部署服务端 (Cloudflare Worker)

服务端利用 Cloudflare 的 Durable Objects (DO) 保持 WebSocket 长连接和内置的 SQLite 存储状态。

**注意**：首次部署**必须**使用 Wrangler 命令行工具，因为需要向 Cloudflare 平台声明 SQLite DO 类的 `migrations`。首次部署成功后，后续如果只修改逻辑，可直接在 Cloudflare Dashboard 网页编辑器中粘贴更新 `worker.js`。

### 1. 登录并初始化
```bash
cd src/worker
npx wrangler login
npx wrangler deploy  # 首次部署，创建 DO 命名空间
```

### 2. 配置密钥 (Secrets)
为了安全，管理密码和签名密钥不能明文写在代码中。部署后请通过命令或在 Dashboard (Settings → Variables & Secrets) 注入以下 4 个环境变量（必须为 Secret 类型）：

```bash
# 面板的网页登录密码
npx wrangler secret put ADMIN_PASSWORD

# 会话 Cookie 的 HMAC 签名密钥 (建议使用随机长字符串)
npx wrangler secret put SESSION_SECRET

# 网页终端 SSH Ticket 签名密钥 (建议使用随机长字符串)
npx wrangler secret put TICKET_KEY

# AES-GCM 密码加密密钥，用于加密"记住密码"功能 (建议使用随机长字符串)
npx wrangler secret put ENC_KEY
```

> **💡 提示**: 强烈建议在 Cloudflare 后台为 Worker 绑定**自定义域名**，因为 `workers.dev` 域名在国内常受网络干扰。另外，记得修改 `worker.js` 顶部的 `CLIENT_URL`，将其替换为你存放已编译好的客户端二进制文件的下载链接，也可以不用管留空，主要是为了方便自己。

---

## 二、构建客户端 (Agent)

客户端由 Go 语言编写，单文件静态编译，无任何依赖。

### 1. 编译脚本
`src/agent/` 下提供了一键交叉编译的脚本，支持快速构建 Linux、macOS、Windows 的各架构版本：

```bash
cd src/agent
chmod +x build.sh
./build.sh
```

构建成功后，所有可执行文件均输出在 `src/agent/out/` 目录下，你可以将其上传至 GitHub Releases 或你自己的文件服务器中。

---

## 三、添加并接入主机

1. 浏览器访问你绑定的服务端域名，使用配置的 `ADMIN_PASSWORD` 登录面板。
2. 点击面板右上角 **「添加主机」**，输入主机备注名称并生成。
3. 此时界面会弹出一个仅显示一次的**注册令牌 (Token)** 和一条启动命令。
4. 将编译好的 agent 下载到目标主机，并执行该命令：
   ```bash
   ./agent --server wss://你的域名 --id h_xxxx --token tk_xxxx --ssh-target 127.0.0.1:22
   ```
   > **高级选项 (私钥免密认证)**: 如果你希望在网页端使用“私钥”模式登录，而不想在网页输入或保存密码，你必须在启动 agent 时加上 `--ssh-key` 参数，并指向主机本地的一把具有登录权限的私钥（如：`/root/.ssh/id_rsa`）。
   > ```bash
   > ./agent --server wss://你的域名 --id h_xxxx --token tk_xxxx --ssh-target 127.0.0.1:22 --ssh-key /root/.ssh/id_rsa
   > ```

5. Agent 成功建连后，面板的主机卡片会自动激活，并每 30 秒实时刷新 CPU、内存、磁盘和运行时间。
6. 如果令牌丢失或需要强制踢下线重新绑定，可在面板的主机卡片上点击 **「重新生成令牌」**。

---

## 四、网页 SSH 功能

在主机在线状态下，点击卡片上的 **「管理」** 按钮，会弹出独立的基于 `xterm.js` 的终端窗口。

### 认证方式
SSH 协议终结在 Agent 客户端（使用 `golang.org/x/crypto/ssh`）。支持两种认证方式：
- **密码认证**：直接在网页终端输入目标主机密码。若勾选“保存密码”，密码会通过 `ENC_KEY` 进行 AES-GCM 加密存储在服务端的 DO SQLite 中，下次自动填充。
- **私钥认证 (安全推荐)**：
  - 必须在目标主机启动 Agent 时，通过 `--ssh-key /path/to/id_rsa` 参数配置好本地私钥（见上一节）。
  - 网页端连接时选择“私钥(主机本地)”即可，无需输入密码。
  - **核心优势**：Agent 会直接读取目标主机上的私钥文件进行登录，**私钥内容和 SSH 口令绝不经过网络，也不会上传给 Cloudflare 服务端**，实现了最高级别的安全。

### 安全控制
- 客户端严格限制 SSH 目标，仅连接 `--ssh-target` 声明的地址（默认本地 `127.0.0.1:22`），有效防止 SSRF。
- WebSocket Ticket 只有 30 秒有效期，且含一次性 Nonce，杜绝重放攻击。
- Agent 每台主机独立 Token 鉴权，无法互相伪造。

---

## 免费额度说明
- **Worker 请求**: WebSocket 消息转发**不计费**，仅初次握手建连算 1 次请求，极低。
- **Durable Objects**: 入站消息按 20:1 计费。Agent 发送状态心跳、服务端推送给浏览器等出站操作完全免费。闲置时连接挂起进入 hibernation 状态，不计算运行时间。
- **结论**: 个人规模完全可稳定在 Cloudflare 免费版（Free Plan）的额度范围内，白嫖无忧。

---
*更多技术细节与实现决策，请参阅 [`docs/design.md`](docs/design.md)*
