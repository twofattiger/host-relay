# host-relay

基于 Cloudflare Workers 免费额度的轻量主机管理面板。Agent 常驻上报状态,经 CF 反向中继(frp 模型)实现网页 SSH。当前为 **M1+M2**:状态上报 + 面板;网页 SSH 为 M3。

## 目录
```
worker.js        服务端(单文件:面板 + 逻辑 + Hub/Host 两个 DO)
wrangler.toml    首次部署配置
agent/           Go 客户端(main.go, go.mod)
```

## 一、部署服务端

首次必须用 wrangler(DO 需声明 migration);之后改代码可直接在 Dashboard 网页编辑器粘贴 worker.js。

```bash
cd host-relay
npx wrangler login
npx wrangler deploy           # 首次,创建 DO 命名空间
```

配置 Secret(Dashboard → Settings → Variables & Secrets,或命令):
```bash
npx wrangler secret put ADMIN_PASSWORD   # 面板登录密码
npx wrangler secret put SESSION_SECRET   # 会话签名密钥,随机长字符串
npx wrangler secret put TICKET_KEY       # SSH ticket 签名密钥,随机长字符串
npx wrangler secret put ENC_KEY          # 保存密码用的 AES-GCM 密钥,随机长字符串
```

> 强烈建议绑定自定义域名(workers.dev 在国内常被污染)。绑定后用 `https://你的域名` 访问。
> 在 `worker.js` 顶部 `CLIENT_URL` 里改成你发布的客户端二进制地址。

## 二、构建客户端

```bash
cd agent
go mod tidy
# 本机构建
go build -o agent .
# 交叉编译(发布到 CLIENT_URL)
GOOS=linux   GOARCH=amd64 go build -o agent-linux-amd64 .
GOOS=darwin  GOARCH=arm64 go build -o agent-darwin-arm64 .
GOOS=windows GOARCH=amd64 go build -o agent-windows-amd64.exe .
```

## 三、添加并接入主机

1. 面板登录 → 点「添加主机」→ 填名称 → 生成。
2. 弹层给出三平台下载链接 + 一行运行命令(令牌只显示一次)。
3. 在目标主机执行该命令:
   ```
   agent --server wss://你的域名 --id h_xxxx --token tk_xxxx --ssh-target 127.0.0.1:22
   ```
   > 若要在网页使用极其安全的“私钥认证”登录，需在上述命令末尾追加 `--ssh-key /root/.ssh/id_rsa` 指向本机的私钥文件。
4. agent 上线后,卡片自动出现并实时刷新 CPU / 内存 / 磁盘 / 运行时长。
5. 令牌丢失或要重置 → 卡片上「重新生成令牌」(旧令牌立即失效,会踢掉旧连接)。

## 四、网页 SSH

在线主机卡片上点「管理」→ 弹出独立终端窗口:
- 填用户名,选认证方式:
  - **密码**:输入密码即可;勾「保存密码」则下次免输入(服务端 AES-GCM 加密存储,可解密,见下)。
  - **私钥**:使用 agent 本机 `--ssh-key` 指定的私钥,私钥不经网络。
- 终端基于 xterm.js,支持窗口自适应(resize)、多会话(可同时开多个终端窗口)。

数据流:浏览器 ⇄ Worker/Host DO ⇄ agent ⇄ `--ssh-target`。agent 用 `x/crypto/ssh` 作客户端终结 SSH,固定只连 `--ssh-target`(忽略任何下发地址,杜绝 SSRF)。终端字节在 CF 边缘/DO 为明文(全程仍 TLS 到边缘)——homelab 自用的取舍;不接受可改用浏览器 WASM SSH(本项目未采用)。

## 行为说明
- 主机三态:`pending`(已生成未上线,不显示,24h 未上线自动清理)→ `active`(在线)→ `offline`(掉线后)。
- 状态经浏览器与 Hub DO 的 WS **推送**,非轮询;掉线 3s 自动重连。
- agent 用 WS 协议 ping 保活(免费),指数退避重连(发版会断开全部连接,靠重连恢复)。
- SSH ticket:面板点「管理」签发,有效期 30s + 一次性 nonce(Host DO 内防重放)。

## 免费额度
- WS 消息经 Worker 转发不计请求;DO 入站消息 20:1 计费;hibernation 期间不计 duration。
- 个人 homelab 规模稳在免费额度内。
