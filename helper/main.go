package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/klauspost/compress/zstd"
)

type request struct {
	ID          string            `json:"id"`
	Op          string            `json:"op"`
	Target      string            `json:"target,omitempty"`
	Path        string            `json:"path,omitempty"`
	Data        string            `json:"data,omitempty"`
	Mode        *uint32           `json:"mode,omitempty"`
	Pattern     string            `json:"pattern,omitempty"`
	Ignore      []string          `json:"ignore,omitempty"`
	Limit       int               `json:"limit,omitempty"`
	Glob        string            `json:"glob,omitempty"`
	IgnoreCase  bool              `json:"ignoreCase,omitempty"`
	Literal     bool              `json:"literal,omitempty"`
	Context     int               `json:"context,omitempty"`
	Command     string            `json:"command,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Compression string            `json:"compression,omitempty"`
}

type frame struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Stream  string `json:"stream,omitempty"`
	Data    string `json:"data,omitempty"`
	Result  any    `json:"result,omitempty"`
	Message string `json:"message,omitempty"`
}

type processRef struct {
	pid       int
	starttime string
	pidfd     int
}

type processControlMode string

const (
	processControlPidfd          processControlMode = "pidfd"
	processControlProcfsFallback processControlMode = "procfs-fallback"
)

var activeProcessControlMode = processControlPidfd
var activeProcessControlDetail string

type trackedGroup struct {
	mu      sync.Mutex
	closed  bool
	pgid    int
	members map[int]*processRef
}

type uploadInput struct {
	data []byte
	end  bool
	err  error
}

type task struct {
	cancel context.CancelFunc
	done   chan struct{}
	input  chan uploadInput
	mu     sync.Mutex
	groups map[int]*trackedGroup
}

type bridge struct {
	writeMu      sync.Mutex
	tasksMu      sync.Mutex
	tasks        map[string]*task
	orphansMu    sync.Mutex
	orphanGroups map[int]*trackedGroup
}

func (b *bridge) emit(value frame) {
	payload, _ := json.Marshal(value)
	b.writeMu.Lock()
	_, _ = os.Stdout.Write(append(payload, '\n'))
	b.writeMu.Unlock()
}

func (b *bridge) fail(id string, err error) {
	b.emit(frame{ID: id, Type: "error", Message: err.Error()})
}
func (b *bridge) meta(id string, value any)   { b.emit(frame{ID: id, Type: "meta", Result: value}) }
func (b *bridge) result(id string, value any) { b.emit(frame{ID: id, Type: "result", Result: value}) }

const (
	sysPidfdSendSignal = 424
	sysPidfdOpen       = 434
)

func pidfdOpen(pid int) (int, error) {
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(pid), 0, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

func pidfdSendSignal(fd int, signal syscall.Signal) error {
	_, _, errno := syscall.Syscall6(sysPidfdSendSignal, uintptr(fd), uintptr(signal), 0, 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func configureProcessControl() error {
	fd, err := pidfdOpen(os.Getpid())
	if err == nil {
		_ = syscall.Close(fd)
		activeProcessControlMode = processControlPidfd
		activeProcessControlDetail = ""
		return nil
	}
	if errors.Is(err, syscall.ENOSYS) {
		activeProcessControlMode = processControlProcfsFallback
		activeProcessControlDetail = err.Error()
		return nil
	}
	return fmt.Errorf("pidfd initialization failed: %w", err)
}

func (t *task) addGroup(pid int) *trackedGroup {
	group := newTrackedGroup(pid)
	t.mu.Lock()
	t.groups[pid] = group
	t.mu.Unlock()
	return group
}

func (t *task) takeGroup(pid int) *trackedGroup {
	t.mu.Lock()
	group := t.groups[pid]
	delete(t.groups, pid)
	t.mu.Unlock()
	return group
}

func waitWithoutReap(pid int) error {
	const (
		pPid    = 1
		wExited = 4
		wNoWait = 0x01000000
	)
	var info [128]byte
	_, _, errno := syscall.Syscall6(syscall.SYS_WAITID, pPid, uintptr(pid), uintptr(unsafe.Pointer(&info[0])), wExited|wNoWait, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func procIdentity(pid int) (pgid int, starttime string, ok bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, "", false
	}
	closeParen := bytes.LastIndexByte(data, ')')
	if closeParen < 0 || closeParen+2 >= len(data) {
		return 0, "", false
	}
	fields := strings.Fields(string(data[closeParen+2:]))
	if len(fields) <= 19 {
		return 0, "", false
	}
	group, err := strconv.Atoi(fields[2])
	if err != nil {
		return 0, "", false
	}
	return group, fields[19], true
}

func openProcessRef(pid, expectedPgid int) (*processRef, bool) {
	pgid, starttime, ok := procIdentity(pid)
	if !ok || pgid != expectedPgid {
		return nil, false
	}
	fd := -1
	if activeProcessControlMode == processControlPidfd {
		var err error
		fd, err = pidfdOpen(pid)
		if err != nil {
			return nil, false
		}
	}
	verifiedPgid, verifiedStarttime, verified := procIdentity(pid)
	if !verified || verifiedPgid != expectedPgid || verifiedStarttime != starttime {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
		return nil, false
	}
	return &processRef{pid: pid, starttime: starttime, pidfd: fd}, true
}

func processRefAlive(ref *processRef) bool {
	if ref.pidfd >= 0 {
		err := pidfdSendSignal(ref.pidfd, 0)
		return err == nil || errors.Is(err, syscall.EPERM)
	}
	_, starttime, ok := procIdentity(ref.pid)
	return ok && starttime == ref.starttime
}

func processRefMatches(ref *processRef, expectedPgid int) bool {
	pgid, starttime, ok := procIdentity(ref.pid)
	return ok && pgid == expectedPgid && starttime == ref.starttime && processRefAlive(ref)
}

func refreshTrackedGroup(group *trackedGroup, allowUnanchored bool) {
	if group == nil {
		return
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.closed {
		return
	}
	anchored := allowUnanchored
	for _, ref := range group.members {
		if processRefMatches(ref, group.pgid) {
			anchored = true
			break
		}
	}
	if !anchored {
		return
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if _, exists := group.members[pid]; exists {
			continue
		}
		if ref, ok := openProcessRef(pid, group.pgid); ok {
			group.members[pid] = ref
		}
	}
}

func newTrackedGroup(pgid int) *trackedGroup {
	group := &trackedGroup{pgid: pgid, members: map[int]*processRef{}}
	refreshTrackedGroup(group, true)
	return group
}

func closeTrackedGroup(group *trackedGroup) {
	if group == nil {
		return
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.closed {
		return
	}
	group.closed = true
	for _, ref := range group.members {
		if ref.pidfd >= 0 {
			_ = syscall.Close(ref.pidfd)
			ref.pidfd = -1
		}
	}
}

func trackedGroupAlive(group *trackedGroup) bool {
	if group == nil {
		return false
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.closed {
		return false
	}
	for _, ref := range group.members {
		if ref.pidfd >= 0 {
			if processRefAlive(ref) {
				return true
			}
			continue
		}
		if processRefMatches(ref, group.pgid) {
			return true
		}
	}
	return false
}

func signalTrackedGroup(group *trackedGroup, signal syscall.Signal) {
	if group == nil {
		return
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.closed {
		return
	}
	for _, ref := range group.members {
		if ref.pidfd >= 0 {
			_ = pidfdSendSignal(ref.pidfd, signal)
			continue
		}
		if processRefMatches(ref, group.pgid) {
			_ = syscall.Kill(ref.pid, signal)
		}
	}
}

func terminateTrackedGroup(group *trackedGroup) {
	if group == nil {
		return
	}
	refreshTrackedGroup(group, false)
	signalTrackedGroup(group, syscall.SIGTERM)
	deadline := time.Now().Add(500 * time.Millisecond)
	for trackedGroupAlive(group) && time.Now().Before(deadline) {
		refreshTrackedGroup(group, false)
		signalTrackedGroup(group, syscall.SIGTERM)
		time.Sleep(20 * time.Millisecond)
	}
	if trackedGroupAlive(group) {
		signalTrackedGroup(group, syscall.SIGKILL)
	}
	closeTrackedGroup(group)
}

func (b *bridge) retainOrphanGroup(group *trackedGroup) {
	if group == nil {
		return
	}
	refreshTrackedGroup(group, false)
	if !trackedGroupAlive(group) {
		closeTrackedGroup(group)
		return
	}
	b.orphansMu.Lock()
	if previous := b.orphanGroups[group.pgid]; previous != nil {
		closeTrackedGroup(previous)
	}
	b.orphanGroups[group.pgid] = group
	b.orphansMu.Unlock()
}

func (b *bridge) stopOrphanGroups() {
	b.orphansMu.Lock()
	groups := make([]*trackedGroup, 0, len(b.orphanGroups))
	for _, group := range b.orphanGroups {
		groups = append(groups, group)
	}
	b.orphanGroups = map[int]*trackedGroup{}
	b.orphansMu.Unlock()
	for _, group := range groups {
		terminateTrackedGroup(group)
	}
}

func (t *task) stopGroups() {
	t.mu.Lock()
	groups := make([]*trackedGroup, 0, len(t.groups))
	for _, group := range t.groups {
		groups = append(groups, group)
	}
	t.mu.Unlock()
	for _, group := range groups {
		terminateTrackedGroup(group)
	}
}

func (b *bridge) command(ctx context.Context, t *task, cwd string, args ...string) ([]byte, []byte, int, error) {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		return nil, nil, -1, err
	}
	group := t.addGroup(cmd.Process.Pid)
	exited := make(chan error, 1)
	go func() { exited <- waitWithoutReap(cmd.Process.Pid) }()
	select {
	case waitErr := <-exited:
		refreshTrackedGroup(group, true)
		err := cmd.Wait()
		b.retainOrphanGroup(t.takeGroup(cmd.Process.Pid))
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		return stdout.Bytes(), stderr.Bytes(), code, errors.Join(waitErr, err)
	case <-ctx.Done():
		t.stopGroups()
		waitErr := <-exited
		err := cmd.Wait()
		closeTrackedGroup(t.takeGroup(cmd.Process.Pid))
		return stdout.Bytes(), stderr.Bytes(), -1, errors.Join(ctx.Err(), waitErr, err)
	}
}

func globRegex(pattern string) (*regexp.Regexp, error) {
	var out strings.Builder
	out.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					out.WriteString("(?:.*/)?")
				} else {
					out.WriteString(".*")
				}
			} else {
				out.WriteString("[^/]*")
			}
		case '?':
			out.WriteString("[^/]")
		default:
			out.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	out.WriteString("$")
	return regexp.Compile(out.String())
}

func matchesGlob(name, pattern string) bool {
	name, pattern = filepath.ToSlash(name), filepath.ToSlash(pattern)
	if !strings.Contains(pattern, "/") {
		ok, _ := filepath.Match(pattern, filepath.Base(name))
		return ok
	}
	rx, err := globRegex(pattern)
	if err != nil {
		return false
	}
	return rx.MatchString(name)
}

func hasGitMarker(root string) bool {
	for current := root; ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false
		}
	}
}

func (b *bridge) files(ctx context.Context, t *task, root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("Path not found: %s", root)
	}
	if !info.IsDir() {
		return []string{filepath.Base(root)}, nil
	}
	marker := hasGitMarker(root)
	if _, err := exec.LookPath("git"); err != nil && marker {
		return nil, errors.New("git is required to honor .gitignore in a repository")
	}
	stdout, probeStderr, code, _ := b.command(ctx, t, root, "git", "-C", root, "rev-parse", "--show-toplevel")
	if code == 0 {
		repo := strings.TrimSpace(string(stdout))
		stdout, stderr, code, err := b.command(ctx, t, repo, "git", "-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", root)
		if err != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if code != 0 {
			return nil, fmt.Errorf("git ls-files failed: %s", strings.TrimSpace(string(stderr)))
		}
		var result []string
		for _, raw := range bytes.Split(stdout, []byte{0}) {
			if len(raw) == 0 {
				continue
			}
			candidate := filepath.Join(repo, string(raw))
			if stat, err := os.Stat(candidate); err == nil && !stat.IsDir() {
				if rel, err := filepath.Rel(root, candidate); err == nil && !strings.HasPrefix(rel, "..") {
					result = append(result, rel)
				}
			}
		}
		return result, nil
	}
	if marker {
		message := strings.TrimSpace(string(probeStderr))
		if message == "" {
			message = "git rev-parse failed"
		}
		return nil, fmt.Errorf("cannot honor .gitignore: %s", message)
	}
	var result []string
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == "node_modules") && path != root {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err == nil {
			result = append(result, rel)
		}
		return nil
	})
	return result, err
}

const (
	copySampleSize           = 256 * 1024
	copyMinCompressionSize   = 1024 * 1024
	copyCompressionThreshold = 0.90
	copyChunkSize            = 64 * 1024
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}

type frameWriter struct {
	bridge    *bridge
	ctx       context.Context
	id        string
	wireBytes int64
}

func (w *frameWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		select {
		case <-w.ctx.Done():
			return written, w.ctx.Err()
		default:
		}
		size := min(copyChunkSize, len(p))
		chunk := p[:size]
		w.bridge.emit(frame{ID: w.id, Type: "data", Stream: "content", Data: base64.StdEncoding.EncodeToString(chunk)})
		w.wireBytes += int64(size)
		written += size
		p = p[size:]
	}
	return written, nil
}

func selectCopyCompression(file *os.File, size int64, requested string) (string, error) {
	switch requested {
	case "none", "zstd":
		return requested, nil
	case "", "auto":
	default:
		return "", fmt.Errorf("unsupported copy compression: %s", requested)
	}
	if size < copyMinCompressionSize {
		return "none", nil
	}
	sample := make([]byte, copySampleSize)
	n, err := file.Read(sample)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if n == 0 {
		return "none", nil
	}
	encoder, err := zstd.NewWriter(nil,
		zstd.WithEncoderLevel(zstd.SpeedFastest),
		zstd.WithEncoderConcurrency(1),
		zstd.WithEncoderCRC(true),
	)
	if err != nil {
		return "", err
	}
	compressed := encoder.EncodeAll(sample[:n], nil)
	encoder.Close()
	if float64(len(compressed)) <= float64(n)*copyCompressionThreshold {
		return "zstd", nil
	}
	return "none", nil
}

func (b *bridge) downloadRequest(ctx context.Context, req request) (map[string]any, error) {
	file, err := os.Open(req.Path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("copy source is not a regular file: %s", req.Path)
	}
	compression, err := selectCopyCompression(file, info.Size(), req.Compression)
	if err != nil {
		return nil, err
	}
	b.meta(req.ID, map[string]any{
		"compression":  compression,
		"logicalBytes": info.Size(),
		"mode":         uint32(info.Mode().Perm()),
	})
	writer := &frameWriter{bridge: b, ctx: ctx, id: req.ID}
	reader := &contextReader{ctx: ctx, reader: file}
	var logicalBytes int64
	if compression == "zstd" {
		encoder, err := zstd.NewWriter(writer,
			zstd.WithEncoderLevel(zstd.SpeedFastest),
			zstd.WithEncoderConcurrency(1),
			zstd.WithEncoderCRC(true),
		)
		if err != nil {
			return nil, err
		}
		logicalBytes, err = io.Copy(encoder, reader)
		closeErr := encoder.Close()
		if err == nil {
			err = closeErr
		}
	} else {
		logicalBytes, err = io.Copy(writer, reader)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"compression":  compression,
		"logicalBytes": logicalBytes,
		"wireBytes":    writer.wireBytes,
		"mode":         uint32(info.Mode().Perm()),
	}, nil
}

func (b *bridge) uploadRequest(ctx context.Context, t *task, req request) (map[string]any, error) {
	if req.Compression != "none" && req.Compression != "zstd" {
		return nil, fmt.Errorf("unsupported upload compression: %s", req.Compression)
	}
	dir := filepath.Dir(req.Path)
	if info, err := os.Stat(dir); err != nil {
		return nil, err
	} else if !info.IsDir() {
		return nil, fmt.Errorf("copy destination parent is not a directory: %s", dir)
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(req.Path)+".pi-cascade-*.part")
	if err != nil {
		return nil, err
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	b.meta(req.ID, map[string]any{"ready": true, "compression": req.Compression})

	pipeReader, pipeWriter := io.Pipe()
	type feedResult struct {
		wireBytes int64
		err       error
	}
	feedDone := make(chan feedResult, 1)
	go func() {
		var wireBytes int64
		for {
			select {
			case <-ctx.Done():
				err := ctx.Err()
				_ = pipeWriter.CloseWithError(err)
				feedDone <- feedResult{wireBytes: wireBytes, err: err}
				return
			case input := <-t.input:
				if input.err != nil {
					_ = pipeWriter.CloseWithError(input.err)
					feedDone <- feedResult{wireBytes: wireBytes, err: input.err}
					return
				}
				if input.end {
					err := pipeWriter.Close()
					feedDone <- feedResult{wireBytes: wireBytes, err: err}
					return
				}
				n, err := pipeWriter.Write(input.data)
				wireBytes += int64(n)
				if err != nil {
					feedDone <- feedResult{wireBytes: wireBytes, err: err}
					return
				}
			}
		}
	}()

	var reader io.Reader = pipeReader
	var decoder *zstd.Decoder
	if req.Compression == "zstd" {
		decoder, err = zstd.NewReader(pipeReader,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderLowmem(true),
		)
		if err != nil {
			_ = pipeReader.CloseWithError(err)
			<-feedDone
			return nil, err
		}
		defer decoder.Close()
		reader = decoder
	}
	logicalBytes, copyErr := io.Copy(temp, &contextReader{ctx: ctx, reader: reader})
	_ = pipeReader.CloseWithError(copyErr)
	feed := <-feedDone
	if copyErr != nil {
		return nil, copyErr
	}
	if feed.err != nil {
		return nil, feed.err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	mode := os.FileMode(0666)
	if req.Mode != nil {
		mode = os.FileMode(*req.Mode) & os.ModePerm
	}
	if err := temp.Chmod(mode); err != nil {
		return nil, err
	}
	if err := temp.Sync(); err != nil {
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.Rename(tempPath, req.Path); err != nil {
		return nil, err
	}
	committed = true
	return map[string]any{
		"compression":  req.Compression,
		"logicalBytes": logicalBytes,
		"wireBytes":    feed.wireBytes,
		"mode":         uint32(mode.Perm()),
	}, nil
}

func (b *bridge) execRequest(ctx context.Context, t *task, req request) (map[string]any, error) {
	cmd := exec.Command("/bin/sh", "-lc", req.Command)
	cmd.Dir = req.Cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = os.Environ()
	for key, value := range req.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	group := t.addGroup(cmd.Process.Pid)
	pump := func(stream io.Reader, name string, done chan<- struct{}) {
		buf := make([]byte, 32768)
		for {
			n, err := stream.Read(buf)
			if n > 0 {
				b.emit(frame{ID: req.ID, Type: "data", Stream: name, Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}
	readers := make(chan struct{}, 2)
	go pump(stdout, "stdout", readers)
	go pump(stderr, "stderr", readers)
	exited := make(chan error, 1)
	go func() { exited <- waitWithoutReap(cmd.Process.Pid) }()
	cancelled := false
	select {
	case <-ctx.Done():
		cancelled = true
		t.stopGroups()
		<-exited
	case <-exited:
		refreshTrackedGroup(group, true)
	}
	_ = cmd.Wait()
	<-readers
	<-readers
	group = t.takeGroup(cmd.Process.Pid)
	if cancelled {
		closeTrackedGroup(group)
	} else {
		b.retainOrphanGroup(group)
	}
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return map[string]any{"exitCode": code}, nil
}

func (b *bridge) handle(ctx context.Context, t *task, req request) (any, error) {
	switch req.Op {
	case "ping":
		home, _ := os.UserHomeDir()
		cwd, _ := os.Getwd()
		gitPath, _ := exec.LookPath("git")
		return map[string]any{
			"protocol": 2, "pid": os.Getpid(), "helper": "go", "go": runtime.Version(),
			"home": home, "cwd": cwd, "gitPath": gitPath,
			"processControl": activeProcessControlMode, "processControlDetail": activeProcessControlDetail,
		}, nil
	case "read":
		data, err := os.ReadFile(req.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(data), "mime": mime.TypeByExtension(filepath.Ext(req.Path))}, nil
	case "mime":
		return map[string]any{"mime": mime.TypeByExtension(filepath.Ext(req.Path))}, nil
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			return nil, err
		}
		file, err := os.OpenFile(req.Path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0666)
		if err != nil {
			return nil, err
		}
		if _, err = file.Write(data); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		return nil, err
	case "access":
		mode := uint32(4)
		if req.Mode != nil {
			mode = *req.Mode
		}
		return nil, syscall.Access(req.Path, mode)
	case "mkdir":
		return nil, os.MkdirAll(req.Path, 0777)
	case "stat":
		info, err := os.Stat(req.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"isDirectory": info.IsDir(), "size": info.Size()}, nil
	case "readdir":
		entries, err := os.ReadDir(req.Path)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		return names, nil
	case "glob":
		files, err := b.files(ctx, t, req.Path)
		if err != nil {
			return nil, err
		}
		if req.Limit <= 0 {
			req.Limit = 1000
		}
		var found []string
		for _, name := range files {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
			ignored := false
			for _, pattern := range req.Ignore {
				if matchesGlob(name, pattern) {
					ignored = true
					break
				}
			}
			if !ignored && matchesGlob(name, req.Pattern) {
				found = append(found, filepath.ToSlash(name))
				if len(found) >= req.Limit {
					break
				}
			}
		}
		return found, nil
	case "grep":
		files, err := b.files(ctx, t, req.Path)
		if err != nil {
			return nil, err
		}
		if req.Limit <= 0 {
			req.Limit = 100
		}
		if req.Context < 0 {
			req.Context = 0
		}
		var rx *regexp.Regexp
		if !req.Literal {
			flags := ""
			if req.IgnoreCase {
				flags = "(?i)"
			}
			rx, err = regexp.Compile(flags + req.Pattern)
			if err != nil {
				return nil, err
			}
		}
		needle := req.Pattern
		if req.IgnoreCase {
			needle = strings.ToLower(needle)
		}
		type lineRecord struct {
			number int
			text   string
		}
		type pendingMatch struct {
			index     int
			remaining int
		}
		matches := make([][]string, 0)
		limitReached := false
		for _, name := range files {
			if req.Glob != "" && !matchesGlob(name, req.Glob) {
				continue
			}
			full := req.Path
			if info, _ := os.Stat(req.Path); info != nil && info.IsDir() {
				full = filepath.Join(req.Path, name)
			}
			file, err := os.Open(full)
			if err != nil {
				continue
			}
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
			before := make([]lineRecord, 0, req.Context)
			pending := make([]pendingMatch, 0)
			lineNo := 0
			for scanner.Scan() {
				lineNo++
				select {
				case <-ctx.Done():
					file.Close()
					return nil, ctx.Err()
				default:
				}
				line := scanner.Text()
				nextPending := pending[:0]
				for _, item := range pending {
					matches[item.index] = append(matches[item.index], fmt.Sprintf("%s-%d- %s", filepath.ToSlash(name), lineNo, line))
					item.remaining--
					if item.remaining > 0 {
						nextPending = append(nextPending, item)
					}
				}
				pending = nextPending
				if len(matches) < req.Limit {
					candidate := line
					if req.IgnoreCase {
						candidate = strings.ToLower(candidate)
					}
					found := req.Literal && strings.Contains(candidate, needle)
					if !req.Literal {
						found = rx.MatchString(line)
					}
					if found {
						block := make([]string, 0, len(before)+1+req.Context)
						for _, prior := range before {
							block = append(block, fmt.Sprintf("%s-%d- %s", filepath.ToSlash(name), prior.number, prior.text))
						}
						block = append(block, fmt.Sprintf("%s:%d: %s", filepath.ToSlash(name), lineNo, line))
						matches = append(matches, block)
						if req.Context > 0 {
							pending = append(pending, pendingMatch{index: len(matches) - 1, remaining: req.Context})
						}
						if len(matches) >= req.Limit {
							limitReached = true
						}
					}
				}
				if req.Context > 0 {
					before = append(before, lineRecord{number: lineNo, text: line})
					if len(before) > req.Context {
						before = before[len(before)-req.Context:]
					}
				}
				if limitReached && len(pending) == 0 {
					break
				}
			}
			scanErr := scanner.Err()
			file.Close()
			if scanErr != nil {
				return nil, scanErr
			}
			if limitReached {
				break
			}
		}
		return map[string]any{"matches": matches, "limitReached": limitReached}, nil
	case "copy_download":
		return b.downloadRequest(ctx, req)
	case "copy_upload":
		return b.uploadRequest(ctx, t, req)
	case "exec":
		return b.execRequest(ctx, t, req)
	default:
		return nil, fmt.Errorf("unknown operation: %s", req.Op)
	}
}

func (b *bridge) start(req request) {
	ctx, cancel := context.WithCancel(context.Background())
	t := &task{cancel: cancel, done: make(chan struct{}), groups: map[int]*trackedGroup{}}
	if req.Op == "copy_upload" {
		t.input = make(chan uploadInput, 8)
	}
	b.tasksMu.Lock()
	b.tasks[req.ID] = t
	b.tasksMu.Unlock()
	go func() {
		defer func() { close(t.done); b.tasksMu.Lock(); delete(b.tasks, req.ID); b.tasksMu.Unlock() }()
		value, err := b.handle(ctx, t, req)
		if err != nil {
			b.fail(req.ID, err)
		} else {
			b.result(req.ID, value)
		}
	}()
}

func (b *bridge) feedUpload(req request) {
	b.tasksMu.Lock()
	t := b.tasks[req.ID]
	b.tasksMu.Unlock()
	if t == nil || t.input == nil {
		return
	}
	input := uploadInput{end: req.Op == "copy_end"}
	if req.Op == "copy_chunk" {
		data, err := base64.StdEncoding.DecodeString(req.Data)
		input.data = data
		input.err = err
	}
	select {
	case t.input <- input:
	case <-t.done:
	}
}

func (b *bridge) cancel(req request) {
	b.tasksMu.Lock()
	t := b.tasks[req.Target]
	b.tasksMu.Unlock()
	if t == nil {
		b.result(req.ID, map[string]any{"cancelled": false, "complete": true})
		return
	}
	t.cancel()
	t.stopGroups()
	select {
	case <-t.done:
		b.result(req.ID, map[string]any{"cancelled": true, "complete": true})
	case <-time.After(2 * time.Second):
		b.result(req.ID, map[string]any{"cancelled": true, "complete": false})
	}
}

func (b *bridge) shutdown() {
	b.tasksMu.Lock()
	tasks := make([]*task, 0, len(b.tasks))
	for _, t := range b.tasks {
		tasks = append(tasks, t)
	}
	b.tasksMu.Unlock()
	for _, t := range tasks {
		t.cancel()
		t.stopGroups()
	}
	deadline := time.After(3 * time.Second)
	for _, t := range tasks {
		select {
		case <-t.done:
		case <-deadline:
			b.stopOrphanGroups()
			return
		}
	}
	b.stopOrphanGroups()
}

func main() {
	if err := configureProcessControl(); err != nil {
		fmt.Fprintf(os.Stderr, "pi-cascade helper cannot initialize process control: %v\n", err)
		os.Exit(1)
	}
	if activeProcessControlMode == processControlProcfsFallback {
		fmt.Fprintf(os.Stderr, "pi-cascade helper: pidfd unavailable (%s); using procfs fallback with reduced PID-reuse protection\n", activeProcessControlDetail)
	}
	b := &bridge{tasks: map[string]*task{}, orphanGroups: map[int]*trackedGroup{}}
	b.emit(frame{ID: "bridge", Type: "ready", Result: map[string]any{
		"protocol": 2, "helper": "go", "processControl": activeProcessControlMode,
	}})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 128*1024*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			b.fail("bridge", err)
			continue
		}
		if req.Op == "cancel" {
			go b.cancel(req)
		} else if req.Op == "copy_chunk" || req.Op == "copy_end" {
			b.feedUpload(req)
		} else {
			b.start(req)
		}
	}
	b.shutdown()
}
