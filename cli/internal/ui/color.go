package ui

// Palette wraps text in ANSI colours when enabled and returns it unchanged
// otherwise, so callers never branch on colour support.
type Palette struct {
	on bool
}

// NewPalette returns a palette that emits colour when enabled.
func NewPalette(enabled bool) Palette { return Palette{on: enabled} }

func (p Palette) wrap(code, s string) string {
	if !p.on || s == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

// Enabled reports whether the palette emits colour.
func (p Palette) Enabled() bool { return p.on }

// Bold renders s in bold.
func (p Palette) Bold(s string) string { return p.wrap("1", s) }

// Dim renders s faint.
func (p Palette) Dim(s string) string { return p.wrap("2", s) }

// Red renders s in red.
func (p Palette) Red(s string) string { return p.wrap("31", s) }

// Green renders s in green.
func (p Palette) Green(s string) string { return p.wrap("32", s) }

// Yellow renders s in yellow.
func (p Palette) Yellow(s string) string { return p.wrap("33", s) }

// Blue renders s in blue.
func (p Palette) Blue(s string) string { return p.wrap("34", s) }

// Magenta renders s in magenta.
func (p Palette) Magenta(s string) string { return p.wrap("35", s) }

// Cyan renders s in cyan.
func (p Palette) Cyan(s string) string { return p.wrap("36", s) }

// Underline renders s underlined.
func (p Palette) Underline(s string) string { return p.wrap("4", s) }

// Status colours a deployment or build status by outcome.
func (p Palette) Status(status string) string {
	switch status {
	case "active", "succeeded", "healthy", "online":
		return p.Green(status)
	case "failed", "crashed", "unhealthy", "offline":
		return p.Red(status)
	case "cancelled", "removed", "rolled_back":
		return p.Dim(status)
	default:
		return p.Yellow(status)
	}
}
