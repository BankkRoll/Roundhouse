package clock

import (
	"net/http"
	"testing"
	"time"
)

func TestOffsetFromResponse(t *testing.T) {
	local := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	resp := &http.Response{Header: http.Header{}}
	resp.Header.Set("Date", local.Add(-10*time.Minute).Format(http.TimeFormat))

	got, ok := OffsetFromResponse(resp, local.Add(-100*time.Millisecond), local.Add(100*time.Millisecond))
	if !ok {
		t.Fatal("expected an offset")
	}
	want := -10*time.Minute + 500*time.Millisecond
	if got != want {
		t.Fatalf("offset = %v, want %v", got, want)
	}
	if got.Abs() <= WarnThreshold {
		t.Fatal("expected offset beyond warn threshold")
	}
}

func TestOffsetFromResponseWithoutDate(t *testing.T) {
	now := time.Now()
	if _, ok := OffsetFromResponse(&http.Response{Header: http.Header{}}, now, now); ok {
		t.Fatal("expected no offset without Date")
	}
	if _, ok := OffsetFromResponse(nil, now, now); ok {
		t.Fatal("expected no offset for nil response")
	}
}
