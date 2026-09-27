//go:build !windows

package main

// runGUI only exists on Windows; other platforms always take the console path.
func runGUI(options guiOptions) {}
