package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"pi-cascade-helper/cifsopts"
)

// cifsCLIRequest 是提权进程的挂载或卸载参数。密码只走 stdin。
type cifsCLIRequest struct {
	MountPoint string `json:"mountPoint"` // 远端挂载点
	Share      string `json:"share"`      // Windows 共享名
	Port       int    `json:"port"`       // 回环转发端口
	Username   string `json:"username"`   // SMB 用户
	Domain     string `json:"domain"`     // SMB 域
	Password   string `json:"password"`   // SMB 密码
	UID        int    `json:"uid"`        // 挂载后的文件属主
	GID        int    `json:"gid"`        // 挂载后的文件属组
}

// runCifsCLI 执行提权后的挂载或卸载，供 sudo 调用。
func runCifsCLI(command string) int {
	var req cifsCLIRequest
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		fmt.Fprintf(os.Stderr, "读取挂载参数失败: %v\n", err)
		return 1
	}
	var err error
	switch command {
	case "cifs-mount":
		err = applyCifsMount(req)
	case "cifs-umount":
		err = applyCifsUmount(req.MountPoint)
	default:
		err = fmt.Errorf("未知命令 %s", command)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	return 0
}

// doCifsMount 在 helper 里挂载。已是 root 时直接挂，否则 sudo -n 重新执行本程序。
func doCifsMount(req request) (any, error) {
	payload := cifsCLIRequest{
		MountPoint: req.Path,
		Share:      req.Share,
		Port:       req.Port,
		Username:   req.Username,
		Domain:     req.Domain,
		Password:   req.Password,
		UID:        os.Getuid(),
		GID:        os.Getgid(),
	}
	var err error
	if os.Geteuid() == 0 {
		err = applyCifsMount(payload)
	} else {
		err = sudoCifs("cifs-mount", payload)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"mountPoint": req.Path}, nil
}

// doCifsUmount 分离挂载点，被占用时也会从目录树上摘掉。
func doCifsUmount(req request) (any, error) {
	var err error
	if os.Geteuid() == 0 {
		err = applyCifsUmount(req.Path)
	} else {
		err = sudoCifs("cifs-umount", cifsCLIRequest{MountPoint: req.Path})
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"mountPoint": req.Path}, nil
}

// sudoCifs 用免密 sudo 执行挂载命令，参数从 stdin 传入。
func sudoCifs(command string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到 helper 路径: %w", err)
	}
	cmd := exec.Command("sudo", "-n", exe, command)
	cmd.Stdin = bytes.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			return fmt.Errorf("sudo %s 失败: %w", command, err)
		}
		return fmt.Errorf("sudo %s 失败: %s", command, detail)
	}
	return nil
}

// applyCifsMount 加载 cifs 模块并调用 mount(2)。
func applyCifsMount(req cifsCLIRequest) error {
	_ = exec.Command("modprobe", "cifs").Run()
	if err := os.MkdirAll(req.MountPoint, 0o755); err != nil {
		return fmt.Errorf("创建挂载点 %s 失败: %w", req.MountPoint, err)
	}
	spec := cifsopts.Mount{
		Host: "127.0.0.1", Share: req.Share, Port: req.Port,
		Username: req.Username, Domain: req.Domain, Password: req.Password,
		UID: req.UID, GID: req.GID,
	}
	if err := syscall.Mount(spec.Source(), req.MountPoint, "cifs", 0, spec.Options()); err != nil {
		return fmt.Errorf("挂载 %s 失败: %w", req.MountPoint, err)
	}
	if err := startMountWatcher(req.Port, req.MountPoint); err != nil {
		_ = syscall.Unmount(req.MountPoint, syscall.MNT_DETACH)
		return fmt.Errorf("启动断线卸载失败: %w", err)
	}
	return nil
}

// startMountWatcher 在转发端口消失后卸载。Windows 断线或进程退出时，这个进程还在服务器上。
func startMountWatcher(port int, mountPoint string) error {
	script := `hex=$(printf '%04X' "$PORT")
while grep -q "0100007F:${hex} " /proc/net/tcp || grep -q "0100007F:${hex} " /proc/net/tcp6; do
  sleep 2
done
umount -l "$MNT" || true
rmdir "$MNT" 2>/dev/null || true
`
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Env = append(os.Environ(), "PORT="+strconv.Itoa(port), "MNT="+mountPoint)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if null, err := os.OpenFile("/dev/null", os.O_RDWR, 0); err == nil {
		cmd.Stdin = null
		cmd.Stdout = null
		cmd.Stderr = null
		defer null.Close()
	}
	return cmd.Start()
}

// applyCifsUmount 用 MNT_DETACH 卸载，避免目录正被访问时留下挂载。
func applyCifsUmount(mountPoint string) error {
	if err := syscall.Unmount(mountPoint, syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("卸载 %s 失败: %w", mountPoint, err)
	}
	return nil
}
