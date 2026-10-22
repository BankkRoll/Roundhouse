package runtime

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	"github.com/shirou/gopsutil/v4/disk"
)

// GCOptions configures image garbage collection. It starts when the disk
// holding Docker's data is at least HighWatermark percent full and removes
// unused images, oldest first, until usage drops below LowWatermark.
type GCOptions struct {
	// Interval between disk checks; zero means [DefaultGCInterval].
	Interval time.Duration
	// HighWatermark and LowWatermark are percentages; zero means 85 and 75.
	HighWatermark, LowWatermark float64
	// DiskUsage returns the used percentage of the filesystem holding path;
	// nil reads it from the host.
	DiskUsage func(ctx context.Context, path string) (float64, error)
}

func (o GCOptions) withDefaults() GCOptions {
	o.Interval = cmp.Or(o.Interval, DefaultGCInterval)
	o.HighWatermark = cmp.Or(o.HighWatermark, 85)
	o.LowWatermark = min(cmp.Or(o.LowWatermark, 75), o.HighWatermark)
	if o.DiskUsage == nil {
		o.DiskUsage = func(ctx context.Context, path string) (float64, error) {
			u, err := disk.UsageWithContext(ctx, path)
			if err != nil {
				return 0, err
			}
			return u.UsedPercent, nil
		}
	}
	return o
}

func (r *Runtime) gcLoop(ctx context.Context) {
	o := r.opts.GC.withDefaults()
	t := time.NewTicker(o.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := r.collectImages(ctx, o); err != nil && ctx.Err() == nil {
				r.log.Warn("image garbage collection", "err", err, "removed", n)
			}
		}
	}
}

// collectImages removes unused images while the disk is under pressure and
// returns how many it removed.
//
// An image is in use if any container on the host, managed or not and
// running or not, was created from it, or if a desired workload names it
// (it may be about to start). The engine refuses to remove an image a
// container uses in any case, so a container created concurrently is safe.
func (r *Runtime) collectImages(ctx context.Context, o GCOptions) (int, error) {
	info, err := r.d.Info(ctx)
	if err != nil {
		return 0, err
	}
	used, err := o.DiskUsage(ctx, info.DockerRootDir)
	if err != nil || used < o.HighWatermark {
		return 0, err
	}

	inUse := map[string]bool{}
	containers, err := r.d.ListContainers(ctx)
	if err != nil {
		return 0, err
	}
	for _, c := range containers {
		inUse[c.ImageID] = true
	}
	r.mu.Lock()
	var refs []string
	if ds := r.desired; ds != nil {
		for _, s := range r.wantSpecs(ds) {
			refs = append(refs, s.Image)
		}
	}
	r.mu.Unlock()
	for _, ref := range refs {
		if img, err := r.d.InspectImage(ctx, ref); err == nil {
			inUse[img.ID] = true
		}
	}

	images, err := r.d.ListImages(ctx)
	if err != nil {
		return 0, err
	}
	slices.SortFunc(images, func(a, b docker.ImageSummary) int {
		return cmp.Compare(a.Created, b.Created)
	})
	removed := 0
	for _, img := range images {
		if inUse[img.ID] {
			continue
		}
		if err := r.d.RemoveImage(ctx, img.ID); err != nil {
			r.log.Debug("keep image", "image", short(img.ID), "err", err)
			continue
		}
		removed++
		r.log.Info("removed unused image under disk pressure", "image", short(img.ID), "tags", img.RepoTags, "size", img.Size)
		if used, err = o.DiskUsage(ctx, info.DockerRootDir); err != nil || used < o.LowWatermark {
			return removed, err
		}
	}
	return removed, nil
}
