// Command genicon draws the icons the installed viewer needs and writes them
// into internal/web/assets. They are committed, so this runs only when the
// mark changes:
//
//	go run ./scripts/genicon
//
// It is here rather than a checked-in binary blob nobody can edit, and it
// uses nothing but the standard library, like everything else in this
// repository.
//
// The mark is a tick on a full-bleed square. Full-bleed because both places
// that show it apply their own mask: iOS rounds an apple-touch-icon itself,
// and a maskable manifest icon may be cropped to a circle. Everything that
// matters therefore stays inside the middle 60%, which is the safe zone both
// masks leave alone.
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

// The two colours are --accent and --panel from app.css, in the light theme.
var (
	back = color.NRGBA{0x8a, 0x5a, 0x2b, 0xff}
	ink  = color.NRGBA{0xff, 0xff, 0xff, 0xff}
)

// The tick, in unit coordinates: two segments and a half-width.
var (
	stroke = [3][2]float64{{0.30, 0.53}, {0.44, 0.68}, {0.72, 0.32}}
	half   = 0.055
)

// sample is the supersampling factor. A tick is all diagonal, so it needs
// antialiasing; sampling is the shortest way to get it without a rasterizer.
const sample = 4

func main() {
	out := filepath.Join("internal", "web", "assets")
	for name, size := range map[string]int{
		"icon-192.png":         192,
		"icon-512.png":         512,
		"apple-touch-icon.png": 180,
	} {
		if err := write(filepath.Join(out, name), size); err != nil {
			log.Fatalf("genicon: %v", err)
		}
	}
}

func write(path string, size int) error {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.SetNRGBA(x, y, blend(back, ink, coverage(x, y, size)))
		}
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

// coverage is how much of one pixel the tick covers, in [0,1].
func coverage(x, y, size int) float64 {
	hits := 0
	for sy := 0; sy < sample; sy++ {
		for sx := 0; sx < sample; sx++ {
			u := (float64(x) + (float64(sx)+0.5)/sample) / float64(size)
			v := (float64(y) + (float64(sy)+0.5)/sample) / float64(size)
			if onStroke(u, v) {
				hits++
			}
		}
	}
	return float64(hits) / float64(sample*sample)
}

func onStroke(u, v float64) bool {
	for i := 0; i+1 < len(stroke); i++ {
		if distance(u, v, stroke[i], stroke[i+1]) <= half {
			return true
		}
	}
	return false
}

// distance is from a point to a segment, with the ends rounded, which is
// what makes the corner of the tick join cleanly.
func distance(u, v float64, a, b [2]float64) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	length := dx*dx + dy*dy
	t := 0.0
	if length > 0 {
		t = ((u-a[0])*dx + (v-a[1])*dy) / length
		t = math.Max(0, math.Min(1, t))
	}
	px, py := a[0]+t*dx, a[1]+t*dy
	return math.Hypot(u-px, v-py)
}

func blend(bg, fg color.NRGBA, alpha float64) color.NRGBA {
	mix := func(b, f uint8) uint8 {
		return uint8(math.Round(float64(b)*(1-alpha) + float64(f)*alpha))
	}
	return color.NRGBA{mix(bg.R, fg.R), mix(bg.G, fg.G), mix(bg.B, fg.B), 0xff}
}
