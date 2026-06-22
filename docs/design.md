# host-relay — 技术设计文档 (v2)

> 基于 Cloudflare Workers 免费额度的轻量主机管理面板:agent 常驻上报状态,经 CF 反向中继实现网页 SSH(frp 模型)。
> 项目族延续 `file-relay` / `ddns-relay` 风格:小写连字符命名、单 `worker.js`、首次 `wrangler deploy`。
> 客户端常驻上报状态 + 通过 WS 反向隧道实现网页 SSH。
> **目标:全程不超出 CF 免费额度,服务端单文件 `worker.js` 复制即可部署。**

---

## 0. 已确认决策

| # | 决策点 | 采用方案 | 备注 |
|---|--------|----------|------|
| 1 | SSH 终结位置 | **agent 终结**:浏览器只跑 xterm.js,Go 客户端用 `x/crypto/ssh` 连本机 22 | 代价:终端明文在 CF 边缘/DO 可见(仍全程 TLS 到边缘) |
| 2 | SSH 凭据 | **密码 + 私钥均支持**。密码可"保存"(AES-GCM 加密落 DO);私钥**提前放 agent 主机本地**,永不离开主机 | 见 §5.5 / §7 |
| 3 | 仪表盘状态读取 | **WS 推送**(浏览器 ↔ Hub DO);状态更新为免费出站消息,开销恒定 | 退化方案:10~15s 轮询亦可,但既有 WS 基建,直接推送更优 |
| 4 | 客户端鉴权 | **每主机注册令牌**:面板生成 `hostId + regToken`,token 仅对该 hostId 有效 | 见 §5.2 / §6.4 |
| 5 | 主机标识 | **由注册令牌绑定**(令牌 → hostId),agent 不能自报/冒充 | 取代"agent 自报主机名" |
| 6 | 添加主机交互 | 面板"添加主机"弹层:`CLIENT_URL` 三平台**纯文字下载链接(无图标)** + 一行通用命令 | server 自动取当前域名,用 `wss://`,见 §6.4 |
| 7 | 主机激活/可见性 | **plan B**:agent 首次上线才 `active` 并显示卡片;`pending` 不显示,24h 未上线自动清理 | 避免空记录堆积 |
| 8 | 令牌补救 | 提供"**重新生成令牌**"按钮,旧 token 立即失效 | token 仅显示一次,丢失即重置 |

---

## 1. 背景与目标

### 1.1 核心问题
- 被管理主机(家用机、各地云服务器)**可能在 NAT 后、无公网 IP**,无法被外部主动连接。
- 需要网页面板:看各客户端状态卡片 + 通过浏览器 SSH 进去管理。
- **白嫖 CF 免费额度**,个人 homelab 低频使用。

### 1.2 方案要点
- 反向隧道(frp 模型):**agent 主动出站**连服务端,服务端经这条长连接反向推下 SSH 会话。NAT 只放行出站,天然穿透。
- CF Worker 入站**只有 443 上的 HTTPS/WSS**(无裸 TCP;裸 TCP 是付费 Spectrum)。所有流量包进 **WSS**。
- Worker 不能持久连接,长连接由 **Durable Object(DO)** 持有;免费版只能用 **SQLite-backed DO**。

### 1.3 范围
- **v1**:状态上报(Linux/macOS/Windows)+ 网页 SSH。
- **不做**:RDP(依赖 guacd 原生守护进程,Workers 跑不了)、商业级高并发。

---

## 2. 总体架构

```
                         ┌─────────────────────── Cloudflare ───────────────────────┐
  浏览器(已登录)         │   Worker (worker.js 单文件)                                │
  ┌──────────────┐       │   fetch() 路由:                                          │
  │ 面板首页 /    │──HTTPS┼─► /              → 内联 HTML 面板                          │
  │ 状态卡片      │◄═WSS══┼═► /ws/status     → 升级转发 Hub DO(状态实时推送)         │
  │ 添加主机      │──────►┼─  /api/enroll    → 生成 hostId + regToken                  │
  │              │       │   /api/login     → 校验口令、下发会话 cookie                │
  │ 点击"管理"    │──────►┼─  /api/ticket    → 校验会话,签发一次性短时 ticket         │
  │ 弹出新窗口    │       │                                                            │
  │ xterm.js     │◄═WSS══┼═► /ws/ssh?ticket=...  → 升级转发 Host DO                   │
  └──────────────┘       │                                                            │
                         │   ┌── Hub DO (单例) ──┐   ┌── Host DO (每主机一个) ──┐    │
                         │   │ 主机注册表/令牌   │   │ 持有 agent 长连接 WS     │    │
                         │   │ 最新状态快照      │◄──┤ SSH 通道复用(channelId) │    │
                         │   │ 浏览器订阅广播    │   │ ticket 校验 / nonce 防重 │    │
                         │   └───────────────────┘   │ 保存密码(AES-GCM)解密   │    │
                         │                            └───────────▲──────────────┘    │
                         └────────────────────────────────────────┼──────────────────┘
                                                                   │ 出站 WSS(长连接)
                                                          ┌────────┴─────────┐
                                                          │ Go Agent (常驻)   │
                                                          │ - 注册(token)    │
                                                          │ - 周期上报状态    │
                                                          │ - 收 ssh_open →   │
                                                          │   dial 127.0.0.1:22
                                                          │   x/crypto/ssh    │
                                                          │   (本地私钥可选)  │
                                                          └───────────────────┘
```

### 2.1 两个 DO 类
- **Host DO(每主机一个,`idFromName(hostId)`)**:持有该主机 agent 长连接、处理 SSH 通道、保存/解密该主机凭据。**就近 pin 到 agent 所在 colo**,隔离各主机流量(DO 单线程 actor)。
- **Hub DO(单例,`idFromName("_hub")`)**:主机注册表 + 令牌 + 状态快照 + 浏览器订阅广播。SSH 字节**绝不**经 Hub。

---

## 3. DO 生命周期与"时间限制"

| 关注点 | 结论 |
|--------|------|
| WS 连接最大时长 | **无上限**,可一直挂着 |
| 空闲 | 进入 **hibernation**:连接保持、不计 duration、免费;来消息自动唤醒 |
| CPU 时间 | 每次 invocation 默认上限 30s,**每收一条消息重置回 30s**;SSH 中继亚毫秒,碰不到 |
| 心跳保活 | WS **协议 ping 帧** + `state.setWebSocketAutoResponse(...)`,边缘自动应答、不唤醒、不计费;**勿用应用层消息做心跳** |
| 部署影响 | **发版会重启所有 DO、断开全部 WS**;agent 必须指数退避自动重连 |
| ⚠️ 计费陷阱 | **DO 内勿用 `connect()` 开出站 TCP**(钉内存最多 15 分钟按 duration 计费)。两条腿都用 `acceptWebSocket()` 接入站 WS;`127.0.0.1:22` 由 **agent dial** |

---

## 4. 免费额度成本模型

| 资源 | 规则 | 本项目 |
|------|------|--------|
| Worker 请求 | 10 万/天;WS 消息转发**不计**,仅建连算 1 次 | 偶尔建连 + 少量 API,极低 |
| 静态资源 | 免费无限 | xterm.js 走 CDN;HTML 内联 |
| DO 请求 | 入站 WS 消息 **20:1**;出站消息 + 协议 ping **免费** | 状态每 30s 一条 → 每主机 ~144/天;SSH 交互量小 |
| DO duration | hibernation 期间不计 | 看输出不敲键盘时全程免费 |
| DO 存储 | SQLite 免费 5GB(2026-01-07 起超量计费) | 注册表/状态/加密密码,KB 级 |
| **状态推送** | Hub→浏览器为**出站消息,免费且不计数** | 开销与时长/标签数无关(恒定) |

**结论:个人规模稳在免费额度内。** 状态用 WS 推送后,连"多标签轮询"这个唯一反模式也消除了。

---

## 5. 客户端(Go Agent)

### 5.1 原则
单静态二进制、无界面、命令行常驻;跨平台(Linux/macOS/Win);核心只有"上报"+"接通 SSH"。

### 5.2 启动参数
```
agent \
  --server   wss://console.example.com   # 服务端
  --id       <hostId>                    # 面板分配
  --token    <regToken>                  # 面板生成,仅对该 hostId 有效
  --ssh-target 127.0.0.1:22              # 默认本机 22(端口做白名单)
  --ssh-key  /path/to/id_ed25519         # 可选:私钥认证用,密钥不离开本机
  --interval 30s                         # 状态上报间隔
```

### 5.3 行为
1. **建连**:出站拨 `wss://.../ws/agent`,发注册帧
   `{type:"register", hostId, token, os, arch, version, displayName?}`。
2. **保活**:周期发 WS **ping 帧**(免费)。
3. **上报状态**:每 `interval` 发
   `{type:"status", ts, cpu, memUsed, memTotal, diskUsed, diskTotal, uptime, load1?, ...}`(`gopsutil` 采集;Windows 无 load 时降级)。
4. **接通 SSH**:收到
   `{type:"ssh_open", channelId, target, username, authType, credential?, cols, rows}`:
   - `x/crypto/ssh` 作客户端拨 `target`(默认 `--ssh-target`,**端口白名单,不盲信下发值**)。
   - `authType=password` → 用 `credential`;`authType=key` → 用 **本地 `--ssh-key`**(忽略下发凭据)。
   - 申请 PTY(初始 `cols/rows`)开 shell;输出按 `channelId` 封帧上行,下行写 stdin,`resize` → `WindowChange`。
   - 回 `{type:"ssh_opened"}` 或 `{type:"ssh_error", msg}`。
5. **多会话**:同一长连接上 `channelId` 复用,每个网页终端一个 channel。
6. **重连**:指数退避(1s→…→30s 上限),覆盖发版断连。

### 5.4 帧格式(agent ↔ Host DO)
- 控制帧:WS 文本 JSON,含 `type` + `channelId`。
- 数据帧:WS 二进制 `[1B type=0x01][2B channelId BE][payload]`,DO 只读头按 channelId 路由。

### 5.5 凭据处理
- **密码**:浏览器输入。若用户勾选"保存",密码经 Host DO **AES-GCM 加密**(`ENC_KEY` 为 Worker secret)存 SQLite,键 `(hostId, username)`。下次 `ssh_open` 由 DO 解密填入,免再输入。
- **私钥**:**提前放在 agent 主机**(`--ssh-key`)。浏览器选"私钥认证"仅告知 agent 用本地密钥,**私钥与口令短语均不经网络**。
- ⚠️ 保存的密码 = 服务端可解密(持 Worker 密钥 + DO 即可还原),与 agent 终结的信任模型一致;不接受则别勾"保存",或全程用私钥认证。

---

## 6. 服务端(worker.js)

### 6.1 路由(`fetch`)
| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 内联 HTML 面板(登录态显示卡片) |
| `/api/login` | POST | 校验 `ADMIN_PASSWORD`,下发 HMAC 会话 cookie + IP 防爆破 |
| `/api/enroll` | POST | 校验会话 → Hub 生成 `hostId + regToken`(状态 `pending`)→ 返回一次性明文 token + agent 命令 + `CLIENT_URL` 三平台下载地址 |
| `/api/regenerate` | POST | 校验会话 → 重置指定 hostId 的 token,返回新的一次性明文 token + 命令 |
| `/api/ticket` | POST | 校验会话 → 签发一次性短时 ticket(§6.5),body 指定 hostId |
| `/ws/status` | GET(Upgrade) | 校验会话 → 转发 Hub DO,订阅状态推送 |
| `/ws/agent` | GET(Upgrade) | 转发对应 Host DO(`idFromName(hostId)`),DO 内校验 token |
| `/ws/ssh` | GET(Upgrade) | 带 `?ticket=...`,转发 Host DO,**ticket 校验在 DO 内** |

> 鉴权在 Worker 层完成(校验 cookie/ticket)后再 upgrade;DO 信任已路由进来的连接。

### 6.2 Host DO 职责
- 持 agent 长连接(`acceptWebSocket` + hibernation + `setWebSocketAutoResponse`)。
- 注册时校验 `token`(对比本地 `tokenHash`,由 Hub 在 enroll 时通过 RPC 下发种子)。
- 接浏览器 WS(校验 ticket → 取 hostId/port → 分配 channelId)。
- 浏览器首帧 `{type:"auth", username, authType, password?, save?}`:
  - `save=true` → AES-GCM 加密存库;若库中已有则可不填密码直接取用。
  - 组装 `ssh_open` 下发 agent;按 channelId 双向转发终端字节(DO 不解析内容)。
- 状态帧到达:更新本地缓存 + RPC 转发摘要给 Hub。
- **首次成功上线**(token 校验通过且建连成功)→ RPC 通知 Hub 将该主机 `pending → active`。
- agent 断开 → 标记 offline 并通知 Hub。

### 6.3 Hub DO 职责
- SQLite:`hosts(hostId PK, displayName, os, tokenHash, state, lastSeen, statusJson, createdAt)`
  - `state`:`pending`(已 enroll 未上线)/ `active`(agent 至少成功上线过一次)/ `offline`(active 过但当前断开)。
- `enroll`:生成 hostId/regToken,存 `tokenHash`,`state=pending`,RPC 给对应 Host DO 种入 tokenHash。
- `regenerate`:对指定 hostId 重置 `tokenHash`(旧 token 立即失效),RPC 更新 Host DO。
- **激活(plan B)**:Host DO 报告 agent 首次成功上线 → Hub 把该 hostId 由 `pending` 置为 `active`。
- **可见性**:面板卡片区**只显示 `active` / `offline`**;`pending` 不显示(只在添加流程里出现过)。
- **清理 alarm**:周期任务(DO Alarm)删除 `state=pending` 且 `createdAt` 超过 24h 的记录,避免点了没部署的空记录堆积。
- 维护**浏览器订阅 WS 列表**;收到 Host DO 转发的状态后**广播**给订阅者(出站消息,免费)。
- 新订阅者连入时先发送当前全量快照,再增量推送。

### 6.4 添加主机 / 注册令牌流程
1. 面板点"添加主机"(已登录)→ `POST /api/enroll {displayName}`。
2. Hub 生成 `hostId`(随机短 id)+ `regToken`(随机 32B),存 `tokenHash=SHA256(regToken)`,`state=pending`,RPC 种入 Host DO。
3. 弹层展示(token 仅此一次可见):
   - **下载区**:`for` 循环 `CLIENT_URL` 三平台**纯文字链接,无图标**。
   - **命令区**:一行通用运行命令(三平台命令相同,只是下载的二进制不同),server 用 **`wss://` + 当前面板域名**(从 `request` host 自动取,不写死;`ws://` 仅本地 `wrangler dev` 调试用):
     ```
     agent --server wss://{当前域名} --id {hostId} --token {regToken} --ssh-target 127.0.0.1:22
     ```
   - 复制按钮。
4. agent 用 `--id/--token` 连接;Host DO 本地校验。**token 仅对其 hostId 有效,无法冒充他机**。
5. agent 首次成功上线 → Host DO 通知 Hub → 该主机 `pending → active`,卡片出现。
6. **令牌丢失/未及时部署**:面板对任一主机提供"**重新生成令牌**"→ `POST /api/regenerate {hostId}`,旧 token 立即失效,弹出新的一次性 token 与命令。

> `CLIENT_URL` 在 worker.js 顶部配置:
> ```js
> const CLIENT_URL = { mac: 'xxx', linux: 'xxx', win: 'xxx' };
> ```
> 弹层直接 `Object.entries(CLIENT_URL)` 循环渲染。

### 6.5 一次性 ticket(SSH 入口)
- 点"管理" → `POST /api/ticket {hostId}` → Worker 签 `payload(hostId,port,exp~30s,nonce) + "." + HMAC(TICKET_KEY)`。
- 浏览器开 `wss://.../ws/ssh?ticket=...`;Host DO 校验 HMAC + 未过期 + nonce 未用过(用过的 nonce 短期留存防重放)。
- **密钥/口令绝不进 URL**。

### 6.6 部署(单文件 + 首次绑定)
- `worker.js` 内同时定义导出 `Hub`、`Host` 两个 DO 类 + 默认 `fetch`。
- **首次用 `wrangler`**(DO 需 migration 声明,Dashboard 编辑器无法新增 DO 类):
  - `wrangler.toml`:`name = "host-relay"`、`main = "worker.js"`、binding(`HUB`、`HOST`)+ `new_sqlite_classes = ["Hub","Host"]`。
  - secrets:`ADMIN_PASSWORD`、`TICKET_KEY`、`ENC_KEY`。
  - `wrangler deploy`。
- **后续更新**:直接把 `worker.js` 粘贴进 Dashboard 编辑器(不新增 DO 类即可)。
- 前端 `xterm.js`/CSS 从 CDN 引入,worker.js 自包含、可复制。

---

## 7. 安全模型

- **信任边界**:agent 终结 SSH ⇒ CF 边缘/DO 可见终端明文(全程仍 TLS 到边缘)。homelab 自用可接受;否则改走浏览器 WASM SSH。
- **凭据**:
  - 密码即时输入 → 仅经 DO 内存中转;勾"保存"才 AES-GCM 落库,**服务端可解密**(见 §5.5)。
  - 私钥**永不离开 agent 主机**(最安全,推荐)。
- **公网暴露面**:Worker 永有公开主机名,全网可探测;唯一闸门是应用层鉴权,**建议前置 Cloudflare Access**。
- **agent 鉴权**:每主机注册令牌,token 绑定 hostId,防冒充。
- **面板鉴权**:口令 + HMAC 会话 cookie + IP 防爆破。
- **ticket**:短 TTL + 一次性 nonce。
- **SSH 目标白名单**:agent 侧只放行允许端口/目标,不盲信下发 `target/port`,防本机 loopback SSRF。

---

## 8. 开发里程碑
1. **M1 通路**:面板 + 登录会话;"添加主机"弹层(CLIENT_URL 下载 + 命令 + 复制 + 重新生成);enroll/regenerate;Host DO 接 agent WS + 令牌校验 + 首次上线激活;Go agent 建连/重连/心跳。
2. **M2 状态**:gopsutil 采集 → 上报 → Host DO → Hub → `/ws/status` 推送 → 卡片实时渲染。
3. **M3 网页 SSH**:ticket + 浏览器 WS + channel 复用 + agent `x/crypto/ssh` 终结(密码/私钥两路)+ xterm.js + resize + 保存密码。
4. **M4 打磨**:断线提示、多会话、错误回显、端口白名单、(可选)CF Access。

---

## 9. 技术选型
| 组件 | 选型 |
|------|------|
| 服务端 | Cloudflare Workers + Durable Objects(SQLite-backed,免费版) |
| 存储 | DO 内嵌 SQLite |
| 长连接保活 | WS 协议 ping + `setWebSocketAutoResponse` + Hibernation API |
| 凭据加密 | AES-GCM(WebCrypto,`ENC_KEY`) |
| 前端终端 | xterm.js(CDN) |
| 客户端 | Go 单静态二进制,headless |
| SSH | `golang.org/x/crypto/ssh`(客户端) |
| 指标采集 | `gopsutil` |
| 部署 | 首次 `wrangler deploy` → 之后粘贴 worker.js |

---

## 10. 已知限制
- **不支持 RDP**(guacd 无法在 Workers 运行)。
- **发版断连**:更新 worker.js 会断开全部在线 agent,靠自动重连秒级恢复。
- **跨区延迟**:Host DO pin 在 agent colo,但"浏览器 → DO"一跳仍可能跨区。
- **CF 可见明文**:见 §7。
- **保存密码可被服务端解密**:见 §5.5。