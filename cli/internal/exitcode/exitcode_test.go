package exitcode

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestOf(t *testing.T) {
	for err, want := range map[error]int{
		nil:                              OK,
		errors.New("plain"):              Error,
		New(NotFound, "missing %s", "x"): NotFound,
		fmt.Errorf("wrapped: %w", New(Conflict, "c")): Conflict,
		context.Canceled:               Interrupted,
		Silent(42):                     42,
		Wrap(Usage, errors.New("bad")): Usage,
	} {
		if got := Of(err); got != want {
			t.Errorf("Of(%v) = %d, want %d", err, got, want)
		}
	}
	if Wrap(Usage, nil) != nil {
		t.Error("Wrap(nil) != nil")
	}
	if !IsSilent(Silent(3)) || IsSilent(New(3, "x")) {
		t.Error("IsSilent")
	}
}
