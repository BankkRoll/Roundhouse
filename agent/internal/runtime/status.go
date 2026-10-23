package runtime

import (
	"context"
	"maps"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// statusBoard holds the latest status of every workload and queues every
// change for sending, in order, so transient states such as pulling reach
// the control plane too. The queue is bounded: if the sender falls far
// behind, queued changes collapse to the newest per workload, so a slow
// connection never backs up the reconciler or grows memory without bound.
type statusBoard struct {
	mu      sync.Mutex
	cur     map[string]protocol.WorkloadStatusReport
	pending []protocol.WorkloadStatusReport
	notify  chan struct{}
}

// maxPendingStatuses bounds the send queue before it collapses.
const maxPendingStatuses = 1024

func newStatusBoard() *statusBoard {
	return &statusBoard{
		cur:    map[string]protocol.WorkloadStatusReport{},
		notify: make(chan struct{}, 1),
	}
}

// set records rep and queues it if it differs from the previous status in
// anything but its timestamp.
func (b *statusBoard) set(rep protocol.WorkloadStatusReport) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.setLocked(rep)
}

func (b *statusBoard) setLocked(rep protocol.WorkloadStatusReport) {
	rep.Message = truncate(rep.Message, protocol.MaxMessageBytes)
	prev, ok := b.cur[rep.WorkloadID]
	rep.TS = prev.TS
	if ok && sameStatus(prev, rep) {
		return
	}
	rep.TS = time.Now().UnixMilli()
	if rep.State == protocol.StateRemoved {
		delete(b.cur, rep.WorkloadID)
	} else {
		b.cur[rep.WorkloadID] = rep
	}
	b.pending = append(b.pending, rep)
	if len(b.pending) > maxPendingStatuses {
		b.pending = collapse(b.pending)
	}
	select {
	case b.notify <- struct{}{}:
	default:
	}
}

// sync records every report; when full, workloads missing from reports are
// reported removed and forgotten.
func (b *statusBoard) sync(reports map[string]protocol.WorkloadStatusReport, full bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, id := range slices.Sorted(maps.Keys(reports)) {
		b.setLocked(reports[id])
	}
	if !full {
		return
	}
	for _, id := range slices.Sorted(maps.Keys(b.cur)) {
		if _, ok := reports[id]; !ok {
			prev := b.cur[id]
			b.setLocked(protocol.WorkloadStatusReport{
				WorkloadID: id, DeploymentID: prev.DeploymentID, State: protocol.StateRemoved,
			})
		}
	}
}

func (b *statusBoard) get(id string) (protocol.WorkloadStatusReport, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rep, ok := b.cur[id]
	return rep, ok
}

// all returns the current statuses ordered by workload ID, at most
// [protocol.MaxStatusesPerHello] of them.
func (b *statusBoard) all() []protocol.WorkloadStatusReport {
	b.mu.Lock()
	defer b.mu.Unlock()
	ids := slices.Sorted(maps.Keys(b.cur))
	out := make([]protocol.WorkloadStatusReport, 0, min(len(ids), protocol.MaxStatusesPerHello))
	for _, id := range ids[:min(len(ids), protocol.MaxStatusesPerHello)] {
		out = append(out, b.cur[id])
	}
	return out
}

// take removes and returns the queued changes in order.
func (b *statusBoard) take() []protocol.WorkloadStatusReport {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.pending
	b.pending = nil
	return out
}

// collapse keeps only the newest queued change of each workload, in the
// order of those changes.
func collapse(q []protocol.WorkloadStatusReport) []protocol.WorkloadStatusReport {
	last := map[string]int{}
	for i, r := range q {
		last[r.WorkloadID] = i
	}
	out := q[:0:0]
	for i, r := range q {
		if last[r.WorkloadID] == i {
			out = append(out, r)
		}
	}
	return out
}

// run sends queued changes through report until ctx ends. A nil report
// discards them.
func (b *statusBoard) run(ctx context.Context, report func(context.Context, protocol.WorkloadStatusReport)) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.notify:
		}
		for _, rep := range b.take() {
			if report != nil && ctx.Err() == nil {
				report(ctx, rep)
			}
		}
	}
}

func sameStatus(a, b protocol.WorkloadStatusReport) bool {
	return a.WorkloadID == b.WorkloadID && a.State == b.State && a.ContainerID == b.ContainerID &&
		a.Message == b.Message && a.Restarts == b.Restarts && ptrEq(a.DeploymentID, b.DeploymentID) &&
		ptrEq(a.ExitCode, b.ExitCode)
}

func ptrEq[T comparable](a, b *T) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// truncate cuts s to at most n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
