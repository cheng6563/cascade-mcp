// Package cifsopts 拼内核 CIFS 挂载参数。SMB 协议在 cifs.ko 里，这里只生成 mount(2) 用的字符串。
package cifsopts

import (
	"strconv"
	"strings"
)

// Mount 是一次回环 CIFS 挂载的参数。
type Mount struct {
	Host     string // 内核看到的服务器地址，隧道场景为 127.0.0.1
	Share    string // Windows 共享名
	Port     int    // 回环上的转发端口
	Username string // SMB 用户
	Domain   string // SMB 域，空则不传
	Password string // SMB 密码，逗号会加倍后写入 pass=
	UID      int    // 挂载后的文件属主，取提权前的 SSH 用户
	GID      int    // 挂载后的文件属组
}

// Source 返回 mount(2) 的源。6.12 起 UNC 以这里为准，选项里的 unc= 会被忽略。
func (m Mount) Source() string {
	return "//" + m.Host + "/" + m.Share
}

// Options 返回 mount data。密码中的逗号写成 ,,，与 mount.cifs 的 set_password 相同。
func (m Mount) Options() string {
	parts := []string{
		"ip=" + m.Host,
		`unc=\\` + m.Host + `\` + m.Share,
		"port=" + strconv.Itoa(m.Port),
		"username=" + m.Username,
	}
	if m.Domain != "" {
		parts = append(parts, "domain="+m.Domain)
	}
	parts = append(parts,
		"uid="+strconv.Itoa(m.UID),
		"gid="+strconv.Itoa(m.GID),
		"forceuid",
		"forcegid",
		"vers=3.1.1",
		"echo_interval=10",
		"pass="+strings.ReplaceAll(m.Password, ",", ",,"),
	)
	return strings.Join(parts, ",")
}
