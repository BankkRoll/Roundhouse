package docker

import (
	"context"
	"io"
	"net/http"
	"net/url"
)

// GetArchive streams a tar of path inside a container (running or not). The
// archive's entries are named from path's base name down, e.g. "data/x" for
// path "/data". The caller must close the stream.
func (c *Client) GetArchive(ctx context.Context, id, path string) (io.ReadCloser, error) {
	return c.openStream(ctx, request{
		method: http.MethodGet,
		path:   "/containers/" + url.PathEscape(id) + "/archive",
		query:  url.Values{"path": {path}},
	})
}

// PutArchive extracts the tar stream r into dir inside a container (running
// or not). dir must exist. Entries keep the owners, modes and times their
// headers carry.
func (c *Client) PutArchive(ctx context.Context, id, dir string, r io.Reader) error {
	q := url.Values{"path": {dir}, "noOverwriteDirNonDir": {"true"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.base+"/containers/"+url.PathEscape(id)+"/archive?"+q.Encode(), r)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-tar")
	// NOTE: the upload can be as large as a volume, so it goes over the
	// stream client and lasts as long as ctx.
	resp, err := c.stream.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBody))
	return nil
}

// SaveImages streams a `docker save` tar of refs. The caller must close the
// stream.
func (c *Client) SaveImages(ctx context.Context, refs ...string) (io.ReadCloser, error) {
	return c.openStream(ctx, request{
		method: http.MethodGet,
		path:   "/images/get",
		query:  url.Values{"names": refs},
	})
}
