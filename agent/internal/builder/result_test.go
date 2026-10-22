package builder

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

func TestBuildResultMapping(t *testing.T) {
	job := validJob()
	red := newRedactor(testToken, nil)
	image := &protocol.BuiltImage{Repository: job.ImageRepository, Digest: "sha256:" + strings.Repeat("0", 64)}

	timedOut, cancel1 := context.WithTimeoutCause(context.Background(), time.Nanosecond, errTimeout)
	defer cancel1()
	<-timedOut.Done()
	cancelled, cancel2 := context.WithCancel(context.Background())
	cancel2()
	live := context.Background()

	cases := []struct {
		name  string
		ctx   context.Context
		image *protocol.BuiltImage
		err   error
		ok    bool
		want  string
	}{
		{"success", live, image, nil, true, ""},
		{"timeout", timedOut, nil, errors.New("context deadline exceeded"), false, "Build timed out after 10m0s and was stopped."},
		{"cancelled", cancelled, nil, context.Canceled, false, "Build was cancelled."},
		{"busy", live, nil, errBusy, false, "Another build is already running on this builder node."},
		{"user error", live, nil, userErrorf("Dockerfile not found at %q", "x/Dockerfile"), false, `Dockerfile not found at "x/Dockerfile"`},
		{"wrapped user error", live, nil, errors.Join(errors.New("ctx"), &userError{msg: "readable"}), false, "readable"},
		{"internal", live, nil, errors.New("docker: boom"), false, "Internal builder error: docker: boom"},
		{"internal leaks token", live, nil, errors.New("git failed with " + testToken), false, "Internal builder error: git failed with " + redactedText},
		{"no image", live, nil, nil, false, "Internal builder error: the build produced no image."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := buildResult(tc.ctx, &job, tc.image, tc.err, 10*time.Minute, 1500*time.Millisecond, red)
			if err := res.Validate(); err != nil {
				t.Fatalf("invalid result %+v: %v", res, err)
			}
			if res.OK != tc.ok || res.Error != tc.want || res.DurationMS != 1500 || res.BuildID != job.BuildID {
				t.Fatalf("result = %+v", res)
			}
		})
	}
}

func TestBuildResultTruncatesLongErrors(t *testing.T) {
	job := validJob()
	long := strings.Repeat("é", protocol.MaxMessageBytes)
	res := buildResult(context.Background(), &job, nil, &userError{msg: long}, time.Minute, 0, nil)
	if err := res.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(res.Error) > protocol.MaxMessageBytes || !strings.HasSuffix(res.Error, "…") {
		t.Fatalf("error of %d bytes", len(res.Error))
	}
}

func TestUserErrorf(t *testing.T) {
	inner := errors.New("inner")
	err := userErrorf("could not do %s: %w", "thing", inner)
	if !errors.Is(err, inner) {
		t.Error("wrapped error lost")
	}
	var ue *userError
	if !errors.As(err, &ue) || ue.msg != "could not do thing: inner" {
		t.Fatalf("msg = %q", ue.msg)
	}
}
