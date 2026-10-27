package conn

import "sync"

// maxRememberedFrames bounds the replay guard's memory. Frames live at most
// a few minutes (plus [ExpiryGrace]), so this is far above what a control
// plane sends in that time, shell keystrokes included.
const maxRememberedFrames = 1 << 17

// replayGuard remembers the IDs of verified control frames until they
// expire, so a frame captured off the wire can't be applied a second time
// within its TTL.
//
// SECURITY: a signature proves who wrote a frame, not that it is new. The
// desired-state generation already defeats replayed state, but a replayed
// exec_input, db_query or build_job would run again. The control plane
// gives every frame a fresh ID, so only a replay repeats one.
type replayGuard struct {
	mu   sync.Mutex
	seen map[string]int64
}

// admit reports whether a frame is new and remembers it until exp (unix ms)
// has passed at now (unix ms, on the clock frames are verified against).
func (g *replayGuard) admit(id string, exp, now int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.seen == nil {
		g.seen = make(map[string]int64)
	}
	if prev, ok := g.seen[id]; ok && prev >= now {
		return false
	}
	if len(g.seen) >= maxRememberedFrames {
		for k, e := range g.seen {
			if e < now {
				delete(g.seen, k)
			}
		}
		// NOTE: still full means an implausible burst of live frames;
		// forgetting some of them only reopens the gap this guard closes,
		// while refusing frames would break the node.
		for k := range g.seen {
			if len(g.seen) < maxRememberedFrames/2 {
				break
			}
			delete(g.seen, k)
		}
	}
	g.seen[id] = exp
	return true
}
