package main

import (
	"bytes"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestMain(m *testing.M) {
	if err := configureProcessControl(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func useProcessControlMode(t *testing.T, mode processControlMode) {
	t.Helper()
	previousMode := activeProcessControlMode
	previousDetail := activeProcessControlDetail
	activeProcessControlMode = mode
	activeProcessControlDetail = "test override"
	t.Cleanup(func() {
		activeProcessControlMode = previousMode
		activeProcessControlDetail = previousDetail
	})
}

func TestPidfdBindsCurrentProcessIdentity(t *testing.T) {
	if activeProcessControlMode != processControlPidfd {
		t.Skip("pidfd is unavailable on this kernel")
	}
	pid := os.Getpid()
	pgid, starttime, ok := procIdentity(pid)
	if !ok {
		t.Fatal("current process identity is unavailable")
	}
	ref, ok := openProcessRef(pid, pgid)
	if !ok {
		t.Fatal("pidfd for current process is unavailable")
	}
	defer syscall.Close(ref.pidfd)
	if ref.starttime != starttime || !processRefMatches(ref, pgid) {
		t.Fatal("pidfd reference should match current process")
	}
	ref.starttime += "-different"
	if processRefMatches(ref, pgid) {
		t.Fatal("changed starttime must be treated as PID reuse")
	}
}

func TestProcfsFallbackBindsCurrentProcessIdentity(t *testing.T) {
	useProcessControlMode(t, processControlProcfsFallback)
	pid := os.Getpid()
	pgid, starttime, ok := procIdentity(pid)
	if !ok {
		t.Fatal("current process identity is unavailable")
	}
	ref, ok := openProcessRef(pid, pgid)
	if !ok {
		t.Fatal("procfs process reference for current process is unavailable")
	}
	if ref.pidfd != -1 {
		t.Fatalf("fallback process reference unexpectedly owns pidfd %d", ref.pidfd)
	}
	if ref.starttime != starttime || !processRefMatches(ref, pgid) {
		t.Fatal("procfs process reference should match current process")
	}
	ref.starttime += "-different"
	if processRefMatches(ref, pgid) {
		t.Fatal("changed starttime must be treated as PID reuse")
	}
}

func testTrackedGroupCapturesAndTerminatesBackgroundMember(t *testing.T) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 &")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	group := newTrackedGroup(cmd.Process.Pid)
	defer closeTrackedGroup(group)
	if err := waitWithoutReap(cmd.Process.Pid); err != nil {
		t.Fatal(err)
	}
	refreshTrackedGroup(group, true)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	backgroundFound := false
	group.mu.Lock()
	for pid, ref := range group.members {
		if pid != cmd.Process.Pid && processRefAlive(ref) {
			backgroundFound = true
		}
	}
	group.mu.Unlock()
	if !backgroundFound {
		t.Fatal("background process was not captured before leader reap")
	}
	terminateTrackedGroup(group)
	if trackedGroupAlive(group) {
		t.Fatal("background process remained alive after process-control cleanup")
	}
}

func TestTrackedGroupCapturesAndTerminatesBackgroundMember(t *testing.T) {
	testTrackedGroupCapturesAndTerminatesBackgroundMember(t)
}

func TestProcfsFallbackCapturesAndTerminatesBackgroundMember(t *testing.T) {
	useProcessControlMode(t, processControlProcfsFallback)
	testTrackedGroupCapturesAndTerminatesBackgroundMember(t)
}

func TestTrackedGroupIncludesCurrentProcess(t *testing.T) {
	pid := os.Getpid()
	pgid, _, ok := procIdentity(pid)
	if !ok {
		t.Fatal("current process identity is unavailable")
	}
	group := newTrackedGroup(pgid)
	defer closeTrackedGroup(group)
	if ref := group.members[pid]; ref == nil || !processRefAlive(ref) {
		t.Fatalf("current process missing from tracked group: pid=%d pgid=%d", pid, pgid)
	}
}

func TestSelectCopyCompression(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) *os.File {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { file.Close() })
		return file
	}

	small := write("small", bytes.Repeat([]byte("a"), 128*1024))
	if got, err := selectCopyCompression(small, 128*1024, "auto"); err != nil || got != "none" {
		t.Fatalf("small auto compression = %q, %v", got, err)
	}
	compressible := write("compressible", bytes.Repeat([]byte("a"), 2*1024*1024))
	if got, err := selectCopyCompression(compressible, 2*1024*1024, "auto"); err != nil || got != "zstd" {
		t.Fatalf("compressible auto compression = %q, %v", got, err)
	}
	randomData := make([]byte, 2*1024*1024)
	if _, err := rand.Read(randomData); err != nil {
		t.Fatal(err)
	}
	incompressible := write("incompressible", randomData)
	if got, err := selectCopyCompression(incompressible, int64(len(randomData)), "auto"); err != nil || got != "none" {
		t.Fatalf("incompressible auto compression = %q, %v", got, err)
	}
	if got, err := selectCopyCompression(incompressible, int64(len(randomData)), "zstd"); err != nil || got != "zstd" {
		t.Fatalf("forced zstd compression = %q, %v", got, err)
	}
}
