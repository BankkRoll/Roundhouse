package dockertest

import "testing"

// The same releases as packages/shared/src/kernel.test.ts, so the two
// copies of the rule can't drift apart unnoticed.
func TestMongoRseqAffected(t *testing.T) {
	affected := []string{
		"6.19.0", "6.19", "6.19-rc1", "6.19.2-arch1-1", "6.19.12-200.fc43.x86_64", "6.20.1",
		"7.0", "7.0.0-14-generic", "7.0.0-1004-azure", "7.0.13", "7.0.13-zen1-1-zen",
	}
	unaffected := []string{
		"6.8.0-45-generic", "6.1.0-28-amd64", "6.18.9", "6.18.99-lts", "6.10.14-linuxkit",
		"6.6.87.2-microsoft-standard-WSL2", "5.15.0-122-generic", "7.0.14", "7.0.14-1-generic",
		"7.0.15-arch1-1", "7.1.0", "8.0.0",
		"", "6", "linux", "v6.19.0", "unknown", "6.x.0", "-6.19.0", "not-a-kernel",
	}
	for _, r := range affected {
		if !MongoRseqAffected(r) {
			t.Errorf("MongoRseqAffected(%q) = false, want true", r)
		}
	}
	for _, r := range unaffected {
		if MongoRseqAffected(r) {
			t.Errorf("MongoRseqAffected(%q) = true, want false", r)
		}
	}
}
