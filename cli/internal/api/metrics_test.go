package api

import (
	"encoding/json"
	"testing"
)

func TestMetricPointJSON(t *testing.T) {
	var got []MetricPoint
	if err := json.Unmarshal([]byte(`[[1792670400000, 12.5], [1792670415000.0, null], [1792670430000, 0]]`), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].T != 1792670400000 || got[0].V == nil || *got[0].V != 12.5 ||
		got[1].T != 1792670415000 || got[1].V != nil || got[2].V == nil || *got[2].V != 0 {
		t.Fatalf("decoded %+v", got)
	}
	out, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if want := `[[1792670400000,12.5],[1792670415000,null],[1792670430000,0]]`; string(out) != want {
		t.Errorf("encoded %s, want %s", out, want)
	}
	for _, bad := range []string{`[1]`, `[1, 2, 3]`, `{"t": 1}`, `["x", 1]`, `[1, "x"]`} {
		var p MetricPoint
		if err := json.Unmarshal([]byte(bad), &p); err == nil {
			t.Errorf("%s: decoded without error", bad)
		}
	}
}
