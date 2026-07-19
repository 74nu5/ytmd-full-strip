# Builds docs/thumbnail.png (1920x960, the 2:1 ratio Maker Console recommends)
# from the real device photo in docs/strip-device.jpg.
#
# The hero is the photo itself: a marketplace listing should show the actual
# product on real hardware, not a mockup.

Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$photo = Join-Path $root 'docs\strip-device.jpg'
$out = Join-Path $root 'docs\thumbnail.png'

$W = 1920
$H = 960

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.PixelOffsetMode = 'HighQuality'
$g.TextRenderingHint = 'AntiAliasGridFit'

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Write-Centered([string]$text, [System.Drawing.Font]$font, [System.Drawing.Color]$colour, [single]$y) {
    $size = $g.MeasureString($text, $font)
    $brush = New-Object System.Drawing.SolidBrush($colour)
    $g.DrawString($text, $font, $brush, ($W - $size.Width) / 2, $y)
    $brush.Dispose()
}

# Background: near-black with a soft warm-dark wash behind the strip, so the
# photo does not sit on a flat void.
$g.Clear([System.Drawing.Color]::FromArgb(0x0d, 0x0d, 0x16))

# Three-stop blend, transparent at both ends: a two-stop gradient leaves a
# visible horizontal seam where the rectangle stops.
$glowRect = New-Object System.Drawing.Rectangle(0, 240, $W, 580)
$glow = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $glowRect,
    [System.Drawing.Color]::Black, [System.Drawing.Color]::Black,
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
$blend.Colors = [System.Drawing.Color[]]@(
    [System.Drawing.Color]::FromArgb(0, 0x23, 0x23, 0x36),
    [System.Drawing.Color]::FromArgb(140, 0x23, 0x23, 0x36),
    [System.Drawing.Color]::FromArgb(0, 0x23, 0x23, 0x36))
$blend.Positions = [single[]]@(0.0, 0.5, 1.0)
$glow.InterpolationColors = $blend
$g.FillRectangle($glow, $glowRect)

$titleFont = New-Object System.Drawing.Font('Segoe UI Semibold', 60, [System.Drawing.FontStyle]::Bold)
$subFont = New-Object System.Drawing.Font('Segoe UI', 28)
$featFont = New-Object System.Drawing.Font('Segoe UI', 24)
$footFont = New-Object System.Drawing.Font('Segoe UI', 22)

# Pink accent rule ABOVE the title, echoing the progress bar and the icon.
# Placed under the title it read as an accidental underline of one word.
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xff, 0x2d, 0x55))
$g.FillRectangle($accent, [single](($W - 96) / 2), [single]104, [single]96, [single]5)

Write-Centered 'Full Strip for YTMD' $titleFont ([System.Drawing.Color]::White) 148

Write-Centered 'Now playing across the entire Stream Deck + touch strip' `
    $subFont ([System.Drawing.Color]::FromArgb(0x9a, 0xa0, 0xb5)) 288

# The photo, at its native width, with rounded corners and a hairline border.
$img = [System.Drawing.Image]::FromFile($photo)
$pw = $img.Width
$ph = $img.Height
$px = ($W - $pw) / 2
$py = 400

$clip = New-RoundedPath $px $py $pw $ph 10
$g.SetClip($clip)
$g.DrawImage($img, [single]$px, [single]$py, [single]$pw, [single]$ph)
$g.ResetClip()
$border = New-Object System.Drawing.Pen(
    [System.Drawing.Color]::FromArgb(40, 255, 255, 255), 2)
$g.DrawPath($border, $clip)
$img.Dispose()

Write-Centered 'Album art  ·  Title  ·  Artist  ·  Progress  ·  Real-time' `
    $featFont ([System.Drawing.Color]::FromArgb(0xc3, 0xc7, 0xd8)) 722

Write-Centered 'Dial = volume   ·   Press = play / pause' `
    $featFont ([System.Drawing.Color]::FromArgb(0xc3, 0xc7, 0xd8)) 772

Write-Centered 'Requires a Stream Deck + and YouTube Music Desktop' `
    $footFont ([System.Drawing.Color]::FromArgb(0x6f, 0x74, 0x88)) 858

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$i = Get-Item $out
"  {0}  {1}x{2}  {3} KB" -f $i.Name, $W, $H, [math]::Round($i.Length / 1KB, 1)
