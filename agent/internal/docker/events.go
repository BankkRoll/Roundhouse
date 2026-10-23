package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
)

// Event is one message of the engine's event stream.
type Event struct {
	// Type is the object type, e.g. "container" or "network".
	Type string `json:"Type"`
	// Action is e.g. "start", "die", "oom", "destroy".
	Action string `json:"Action"`
	Actor  struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
	// TimeNano is unix nanoseconds.
	TimeNano int64 `json:"timeNano"`
}

// Events streams engine events matching filters (e.g. {"type":
// ["container"], "label": ["roundhouse.managed=true"]}) until ctx ends or the
// connection drops. fn is called for each event in order. It returns nil
// when ctx is cancelled.
func (c *Client) Events(ctx context.Context, filters map[string][]string, fn func(Event)) error {
	q := url.Values{}
	if len(filters) > 0 {
		q.Set("filters", labelFilters(filters))
	}
	body, err := c.openStream(ctx, request{method: http.MethodGet, path: "/events", query: q})
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer body.Close()
	dec := json.NewDecoder(body)
	for {
		var ev Event
		if err := dec.Decode(&ev); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, io.EOF) {
				return io.ErrUnexpectedEOF
			}
			return err
		}
		fn(ev)
	}
}
