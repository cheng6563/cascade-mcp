package cifsopts

import (
	"strings"
	"testing"
)

func TestMountOptions(t *testing.T) {
	got := Mount{
		Host: "127.0.0.1", Share: "sh", Port: 1445,
		Username: "human", Domain: "DESK", Password: "a,b",
		UID: 1000, GID: 1000,
	}
	if got.Source() != "//127.0.0.1/sh" {
		t.Fatalf("source: %s", got.Source())
	}
	opts := got.Options()
	for _, want := range []string{
		"ip=127.0.0.1",
		`unc=\\127.0.0.1\sh`,
		"port=1445",
		"username=human",
		"domain=DESK",
		"uid=1000",
		"gid=1000",
		"vers=3.1.1",
		"echo_interval=10",
		"pass=a,,b",
	} {
		if !strings.Contains(opts, want) {
			t.Fatalf("missing %s in %s", want, opts)
		}
	}
}

func TestMountOptionsOmitsEmptyDomain(t *testing.T) {
	opts := Mount{Host: "127.0.0.1", Share: "sh", Username: "human", Password: "x", UID: 1, GID: 1}.Options()
	if strings.Contains(opts, "domain=") {
		t.Fatalf("empty domain should be omitted: %s", opts)
	}
}
