package builder

import "golang.org/x/sys/windows"

// freeBytes returns the space available to the caller on the volume holding
// path.
func freeBytes(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var avail uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, nil, nil); err != nil {
		return 0, err
	}
	return avail, nil
}
