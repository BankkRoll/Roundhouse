package browser

import "testing"

func TestOpenRejectsNonHTTP(t *testing.T) {
	for _, u := range []string{"file:///etc/passwd", "javascript:alert(1)", "C:\\Windows\\notepad.exe", "/relative", "https://"} {
		if err := Open(u); err == nil {
			t.Errorf("Open(%q) accepted", u)
		}
	}
}
