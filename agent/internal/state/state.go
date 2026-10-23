// Package state persists the small amount of agent state that must survive
// restarts, currently just the observed desired-state generation.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
)

// State is the agent's persisted state.
type State struct {
	// ObservedGeneration is the newest desired_state generation applied.
	ObservedGeneration int64 `json:"observed_generation"`
}

// Store reads and writes [State] at a fixed path.
type Store struct {
	path string
}

// NewStore returns a store backed by the JSON file at path.
func NewStore(path string) *Store {
	return &Store{path: path}
}

// Load returns the persisted state, or the zero State if none has been saved.
func (s *Store) Load() (State, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return State{}, err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return State{}, fmt.Errorf("parse %s: %w", s.path, err)
	}
	return st, nil
}

// Save atomically persists st.
func (s *Store) Save(st State) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return atomicfile.Write(s.path, append(data, '\n'), 0o600)
}
