package volumes

import "testing"

func TestParseMountinfo(t *testing.T) {
	data := []byte("36 35 98:0 / /mnt1 rw,noatime master:1 - ext3 /dev/root rw\n" +
		`40 35 7:3 / /var/lib/roundhouse/volumes/mnt/vol\040x rw,nosuid,nodev,noatime - ext4 /dev/loop3 rw` + "\n")
	src, ok := parseMountinfo(data, "/var/lib/roundhouse/volumes/mnt/vol x")
	if !ok || src != "/dev/loop3" {
		t.Fatalf("got %q %v", src, ok)
	}
	if _, ok := parseMountinfo(data, "/var/lib/roundhouse/volumes/mnt"); ok {
		t.Fatal("matched a parent directory")
	}
}
