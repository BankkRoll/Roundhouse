package protocol

import (
	"errors"
	"fmt"
)

// JobRun starts one run-to-completion container (ADR 0010). Workload is a
// [WorkloadJob] whose environment opens with [OpenJobEnv]. Always
// credential-bearing. Type must be [TypeJobRun].
type JobRun struct {
	Type string `json:"type"`
	ControlHeader
	RunID    string       `json:"run_id"`
	Workload WorkloadSpec `json:"workload"`
	// TimeoutS is when the agent sends SIGTERM, then SIGKILL after KillGraceS.
	TimeoutS   int `json:"timeout_s"`
	KillGraceS int `json:"kill_grace_s"`
}

func (*JobRun) controlMessage() {}

// Validate implements [Validator].
func (m *JobRun) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.RunID) {
		return fmt.Errorf("run_id: invalid %q", m.RunID)
	}
	if err := m.Workload.Validate(); err != nil {
		return fmt.Errorf("workload: %w", err)
	}
	if m.Workload.Kind != WorkloadJob {
		return errors.New("workload: job_run carries a job workload")
	}
	if m.TimeoutS < MinJobTimeoutS || m.TimeoutS > MaxJobTimeoutS || m.KillGraceS < 1 || m.KillGraceS > 120 {
		return errors.New("timeout_s or kill_grace_s: out of range")
	}
	return validateShortLived(m)
}

// JobCancel stops a run; the agent answers with a cancelled [JobStatus].
// Type must be [TypeJobCancel].
type JobCancel struct {
	Type string `json:"type"`
	ControlHeader
	RunID string `json:"run_id"`
	// Reason goes to the run's system log.
	Reason string `json:"reason"`
}

func (*JobCancel) controlMessage() {}

// Validate implements [Validator].
func (m *JobCancel) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.RunID) || len(m.Reason) > 256 {
		return errors.New("run_id or reason: invalid")
	}
	return nil
}

// JobState is a run's lifecycle state.
type JobState string

// Job states; succeeded, failed, timed_out and cancelled are terminal.
const (
	JobPulling   JobState = "pulling"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
	JobTimedOut  JobState = "timed_out"
	JobCancelled JobState = "cancelled"
)

// Terminal reports whether s ends a run.
func (s JobState) Terminal() bool {
	return s == JobSucceeded || s == JobFailed || s == JobTimedOut || s == JobCancelled
}

// JobStatus reports a run's state change, and is re-sent after an agent
// restart for runs it re-attached to or found finished. Type must be
// [TypeJobStatus].
type JobStatus struct {
	Type       string   `json:"type"`
	RunID      string   `json:"run_id"`
	WorkloadID string   `json:"workload_id"`
	State      JobState `json:"state"`
	ExitCode   *int     `json:"exit_code,omitempty"`
	StartedAt  *int64   `json:"started_at,omitempty"`
	// FinishedAt is set exactly in terminal states.
	FinishedAt *int64 `json:"finished_at,omitempty"`
	Message    string `json:"message,omitempty"`
}

func (*JobStatus) agentMessage() {}

// Validate implements [Validator].
func (m *JobStatus) Validate() error {
	if !idRE.MatchString(m.RunID) || !idRE.MatchString(m.WorkloadID) {
		return errors.New("run_id and workload_id must be ids")
	}
	switch m.State {
	case JobPulling, JobRunning, JobSucceeded, JobFailed, JobTimedOut, JobCancelled:
	default:
		return fmt.Errorf("state: invalid %q", m.State)
	}
	if m.State.Terminal() != (m.FinishedAt != nil) {
		return errors.New("finished_at: required exactly in terminal states")
	}
	if m.State == JobSucceeded && (m.ExitCode == nil || *m.ExitCode != 0) {
		return errors.New("exit_code: a succeeded run exited 0")
	}
	if (m.ExitCode != nil && (*m.ExitCode < -1 || *m.ExitCode > 255)) || (m.StartedAt != nil && *m.StartedAt < 0) ||
		(m.FinishedAt != nil && *m.FinishedAt < 0) || len(m.Message) > MaxMessageBytes {
		return errors.New("exit_code, timestamps or message: out of range")
	}
	return nil
}
