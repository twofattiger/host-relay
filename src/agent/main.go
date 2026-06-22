// host-relay agent — 常驻客户端(M1+M2 状态上报 + M3 网页 SSH 终结)
// 无界面,命令行运行。
//
// 用法:
//   agent --server wss://host-relay.example.com --id h_xxxx --token tk_xxxx \
//         --ssh-target 127.0.0.1:22 --interval 30s
//   私钥认证(网页选"私钥"时使用本机密钥,不经网络):
//   agent ... --ssh-key /root/.ssh/id_ed25519
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"golang.org/x/crypto/ssh"
)

const version = "0.2.0"

var (
	server    = flag.String("server", "", "服务端地址,如 wss://host-relay.example.com(必填)")
	hostID    = flag.String("id", "", "面板分配的主机 ID(必填)")
	token     = flag.String("token", "", "面板生成的令牌(必填)")
	sshTarget = flag.String("ssh-target", "127.0.0.1:22", "SSH 目标(白名单:agent 只连此地址,忽略服务端下发)")
	sshKey    = flag.String("ssh-key", "", "私钥文件路径(私钥认证用,不离开本机)")
	interval  = flag.Duration("interval", 30*time.Second, "状态上报间隔")
	diskPath  = flag.String("disk-path", defaultDiskPath(), "磁盘用量统计路径")
)

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}

type outMsg struct {
	Type      string  `json:"type"`
	HostID    string  `json:"hostId,omitempty"`
	Token     string  `json:"token,omitempty"`
	OS        string  `json:"os,omitempty"`
	Arch      string  `json:"arch,omitempty"`
	Version   string  `json:"version,omitempty"`
	Hostname  string  `json:"hostname,omitempty"`
	Platform  string  `json:"platform,omitempty"`
	TS        int64   `json:"ts,omitempty"`
	CPU       float64 `json:"cpu"`
	MemUsed   uint64  `json:"memUsed,omitempty"`
	MemTotal  uint64  `json:"memTotal,omitempty"`
	DiskUsed  uint64  `json:"diskUsed,omitempty"`
	DiskTotal uint64  `json:"diskTotal,omitempty"`
	Uptime    uint64  `json:"uptime,omitempty"`
	Load1     float64 `json:"load1"`
	PublicIP  string  `json:"publicIp,omitempty"`
	LocalIPs  []string `json:"localIps,omitempty"`
	// SSH 回执
	ChannelID uint16 `json:"channelId,omitempty"`
	Msg       string `json:"msg,omitempty"`
}

type inMsg struct {
	Type       string `json:"type"`
	Msg        string `json:"msg"`
	ChannelID  uint16 `json:"channelId"`
	Username   string `json:"username"`
	AuthType   string `json:"authType"`
	Credential string `json:"credential"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

type sshChan struct {
	client *ssh.Client
	sess   *ssh.Session
	stdin  io.WriteCloser
}

// 串行化所有写入(gorilla 要求单写者),并管理 SSH 通道
type conn struct {
	ws    *websocket.Conn
	mu    sync.Mutex
	cmu   sync.Mutex
	chans map[uint16]*sshChan
}

func (c *conn) writeJSON(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(v)
}

func (c *conn) writeBinary(cid uint16, payload []byte) {
	frame := make([]byte, 3+len(payload))
	frame[0] = 1
	frame[1] = byte(cid >> 8)
	frame[2] = byte(cid)
	copy(frame[3:], payload)
	c.mu.Lock()
	_ = c.ws.WriteMessage(websocket.BinaryMessage, frame)
	c.mu.Unlock()
}

func (c *conn) writePing() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

func main() {
	flag.Parse()
	if *server == "" || *hostID == "" || *token == "" {
		log.Fatal("缺少必填参数:--server / --id / --token")
	}
	u, err := url.Parse(*server)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") {
		log.Fatalf("server 地址非法,应以 ws:// 或 wss:// 开头: %v", err)
	}
	u.Path = "/ws/agent"
	u.RawQuery = "id=" + url.QueryEscape(*hostID)

	hostname, _ := os.Hostname()
	log.Printf("host-relay agent v%s 启动,目标 %s(主机 %s,ssh→%s)", version, u.String(), *hostID, *sshTarget)
	_, _ = cpu.Percent(0, false) // 预热基线

	backoff := time.Second
	for {
		if err := runOnce(u.String(), hostname); err != nil {
			log.Printf("连接结束: %v;%.0fs 后重连", err, backoff.Seconds())
		}
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func runOnce(wsURL, hostname string) error {
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer ws.Close()
	c := &conn{ws: ws, chans: map[uint16]*sshChan{}}
	defer c.closeAllChans()

	if err := c.writeJSON(outMsg{
		Type: "register", HostID: *hostID, Token: *token,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Version: version, Hostname: hostname,
	}); err != nil {
		return err
	}

	done := make(chan error, 1)
	_, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		first := true
		for {
			mt, data, err := ws.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			if mt == websocket.BinaryMessage {
				c.routeBinary(data)
				continue
			}
			var m inMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			if first {
				first = false
				if m.Type == "registered" {
					done <- nil
				} else {
					done <- &authErr{m.Msg}
					return
				}
				continue
			}
			c.handleMessage(m)
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			return err
		}
	case <-time.After(10 * time.Second):
		return &authErr{"注册超时"}
	}
	log.Printf("已注册,开始上报(每 %s)", interval.String())

	pingT := time.NewTicker(30 * time.Second)
	defer pingT.Stop()
	statusT := time.NewTicker(*interval)
	defer statusT.Stop()
	
	// 从 wsURL 解析出 scheme 和 host，用于获取 IP
	u, _ := url.Parse(wsURL)
	reportStatus(c, hostname, u.Scheme, u.Host)

	for {
		select {
		case <-pingT.C:
			if err := c.writePing(); err != nil {
				return err
			}
		case <-statusT.C:
			reportStatus(c, hostname, u.Scheme, u.Host)
		case err := <-done:
			return err
		}
	}
}

func reportStatus(c *conn, hostname, scheme, host string) {
	if err := c.writeJSON(collectStatus(hostname, scheme, host)); err != nil {
		log.Printf("上报失败: %v", err)
	}
}

func collectStatus(hostname, scheme, hostAddr string) outMsg {
	m := outMsg{Type: "status", TS: time.Now().UnixMilli(), Hostname: hostname}
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		m.CPU = pcts[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		m.MemUsed, m.MemTotal = vm.Used, vm.Total
	}
	if du, err := disk.Usage(*diskPath); err == nil {
		m.DiskUsed, m.DiskTotal = du.Used, du.Total
	}
	if hi, err := host.Info(); err == nil {
		m.Uptime = hi.Uptime
		m.Platform = hi.Platform
		if hi.PlatformVersion != "" {
			m.Platform = hi.Platform + " " + hi.PlatformVersion
		}
	}
	if runtime.GOOS != "windows" {
		if la, err := load.Avg(); err == nil {
			m.Load1 = la.Load1
		}
	}

	m.PublicIP = getPublicIP(scheme, hostAddr)
	m.LocalIPs = getLocalIPs()

	return m
}

func getPublicIP(scheme, host string) string {
	httpScheme := "http"
	if scheme == "wss" || scheme == "https" {
		httpScheme = "https"
	}
	apiURL := httpScheme + "://" + host + "/api/ip"

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(apiURL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		ip, _ := io.ReadAll(resp.Body)
		return string(ip)
	}
	return ""
}

func getLocalIPs() []string {
	var ips []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				ips = append(ips, ipnet.IP.String())
			}
		}
	}
	return ips
}

// ----------------- 消息分发 -----------------
func (c *conn) handleMessage(m inMsg) {
	switch m.Type {
	case "ssh_open":
		go c.openSSH(m)
	case "resize":
		c.cmu.Lock()
		ch := c.chans[m.ChannelID]
		c.cmu.Unlock()
		if ch != nil && ch.sess != nil {
			_ = ch.sess.WindowChange(m.Rows, m.Cols)
		}
	case "ssh_close":
		c.closeChan(m.ChannelID)
	}
}

func (c *conn) routeBinary(data []byte) {
	if len(data) < 3 || data[0] != 1 {
		return
	}
	cid := uint16(data[1])<<8 | uint16(data[2])
	c.cmu.Lock()
	ch := c.chans[cid]
	c.cmu.Unlock()
	if ch != nil && ch.stdin != nil {
		_, _ = ch.stdin.Write(data[3:])
	}
}

// ----------------- SSH 终结 -----------------
type chanWriter struct {
	c   *conn
	cid uint16
}

func (w chanWriter) Write(p []byte) (int, error) {
	w.c.writeBinary(w.cid, p)
	return len(p), nil
}

func (c *conn) openSSH(m inMsg) {
	sendErr := func(msg string) {
		_ = c.writeJSON(outMsg{Type: "ssh_error", ChannelID: m.ChannelID, Msg: msg})
	}

	var auth []ssh.AuthMethod
	if m.AuthType == "key" {
		if *sshKey == "" {
			sendErr("agent 未配置 --ssh-key,无法使用私钥认证")
			return
		}
		kb, err := os.ReadFile(*sshKey)
		if err != nil {
			sendErr("读取私钥失败: " + err.Error())
			return
		}
		signer, err := ssh.ParsePrivateKey(kb)
		if err != nil {
			sendErr("私钥解析失败(暂不支持带口令私钥): " + err.Error())
			return
		}
		auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	} else {
		auth = []ssh.AuthMethod{ssh.Password(m.Credential)}
	}

	cfg := &ssh.ClientConfig{
		User:            m.Username,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 连本机/局域网,跳过 host key 校验
		Timeout:         10 * time.Second,
	}

	client, err := ssh.Dial("tcp", *sshTarget, cfg) // 固定连 --ssh-target,忽略下发,杜绝 SSRF
	if err != nil {
		sendErr("SSH 连接失败: " + err.Error())
		return
	}
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		sendErr("创建会话失败: " + err.Error())
		return
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		client.Close()
		sendErr("stdin 失败: " + err.Error())
		return
	}
	w := chanWriter{c: c, cid: m.ChannelID}
	sess.Stdout = w
	sess.Stderr = w

	cols, rows := m.Cols, m.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		client.Close()
		sendErr("申请 PTY 失败: " + err.Error())
		return
	}
	if err := sess.Shell(); err != nil {
		sess.Close()
		client.Close()
		sendErr("启动 shell 失败: " + err.Error())
		return
	}

	c.cmu.Lock()
	c.chans[m.ChannelID] = &sshChan{client: client, sess: sess, stdin: stdin}
	c.cmu.Unlock()

	_ = c.writeJSON(outMsg{Type: "ssh_opened", ChannelID: m.ChannelID})

	// 阻塞直到会话结束(用户 exit / 连接断开),然后清理并通知
	go func() {
		_ = sess.Wait()
		c.cmu.Lock()
		delete(c.chans, m.ChannelID)
		c.cmu.Unlock()
		client.Close()
		_ = c.writeJSON(outMsg{Type: "ssh_close", ChannelID: m.ChannelID})
	}()
}

func (c *conn) closeChan(cid uint16) {
	c.cmu.Lock()
	ch := c.chans[cid]
	delete(c.chans, cid)
	c.cmu.Unlock()
	if ch != nil {
		if ch.sess != nil {
			ch.sess.Close()
		}
		if ch.client != nil {
			ch.client.Close()
		}
	}
}

func (c *conn) closeAllChans() {
	c.cmu.Lock()
	chans := c.chans
	c.chans = map[uint16]*sshChan{}
	c.cmu.Unlock()
	for _, ch := range chans {
		if ch.sess != nil {
			ch.sess.Close()
		}
		if ch.client != nil {
			ch.client.Close()
		}
	}
}

type authErr struct{ s string }

func (e *authErr) Error() string {
	if e.s == "" {
		return "注册被拒绝"
	}
	return "注册被拒绝: " + e.s
}