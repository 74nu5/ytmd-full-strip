# Builds docs/thumbnail-v2.png — punchier variant of the Marketplace thumbnail.
#
# Same rule as v1: the subject is the real device photo. Everything added here
# is styling (halo, vignette, typography), never invented functionality.

Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$photo = Join-Path $root 'docs\strip-device.jpg'
$out = Join-Path $root 'docs\thumbnail-v2.png'

$W = 1920
$H = 960
$PINK = [System.Drawing.Color]::FromArgb(0xff, 0x2d, 0x55)

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

# Shrinks the font until the string fits maxWidth: a hard-coded size would
# silently overflow the canvas if the title ever changes.
function Get-FittedFont([string]$text, [string]$family, [single]$start, [single]$maxWidth, $style) {
    $size = $start
    while ($size -gt 10) {
        $f = New-Object System.Drawing.Font($family, $size, $style)
        if ($g.MeasureString($text, $f).Width -le $maxWidth) { return $f }
        $f.Dispose()
        $size -= 2
    }
    return (New-Object System.Drawing.Font($family, 10, $style))
}

function Write-Centered([string]$text, $font, $colour, [single]$y) {
    $size = $g.MeasureString($text, $font)
    $brush = New-Object System.Drawing.SolidBrush($colour)
    $g.DrawString($text, $font, $brush, ($W - $size.Width) / 2, $y)
    $brush.Dispose()
    return $size.Height
}

# Letter-spaced small caps, drawn glyph by glyph: GDI+ has no tracking.
function Write-Tracked([string]$text, $font, $colour, [single]$y, [single]$track) {
    $total = 0
    foreach ($ch in $text.ToCharArray()) {
        $total += $g.MeasureString([string]$ch, $font).Width - 4 + $track
    }
    $x = ($W - $total) / 2
    $brush = New-Object System.Drawing.SolidBrush($colour)
    foreach ($ch in $text.ToCharArray()) {
        $g.DrawString([string]$ch, $font, $brush, $x, $y)
        $x += $g.MeasureString([string]$ch, $font).Width - 4 + $track
    }
    $brush.Dispose()
}

# --- Background: radial vignette, brighter in the middle ---------------------
$vig = New-Object System.Drawing.Drawing2D.GraphicsPath
$vig.AddEllipse(-420, -560, $W + 840, $H + 1120)
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($vig)
$pgb.CenterPoint = New-Object System.Drawing.PointF([single]($W / 2), [single]500)
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(255, 0x1c, 0x1c, 0x30)
$pgb.SurroundColors = [System.Drawing.Color[]]@(
    [System.Drawing.Color]::FromArgb(255, 0x05, 0x05, 0x0b))
$g.FillPath($pgb, $vig)

# --- Type block --------------------------------------------------------------
$kickerFont = New-Object System.Drawing.Font('Segoe UI', 21, [System.Drawing.FontStyle]::Bold)
Write-Tracked 'STREAM DECK +' $kickerFont $PINK 74 9

$titleFont = Get-FittedFont 'FULL STRIP FOR YTMD' 'Segoe UI Black' 108 1660 ([System.Drawing.FontStyle]::Bold)
Write-Centered 'FULL STRIP FOR YTMD' $titleFont ([System.Drawing.Color]::White) 118 | Out-Null

$subFont = New-Object System.Drawing.Font('Segoe UI', 30)
Write-Centered 'Album art, title and progress — across all four dials, seamlessly' `
    $subFont ([System.Drawing.Color]::FromArgb(0xa8, 0xae, 0xc4)) 302 | Out-Null

# --- The photo, wearing a neon halo -----------------------------------------
$img = [System.Drawing.Image]::FromFile($photo)
$pw = 1700
$ph = [int][Math]::Round($img.Height * ($pw / $img.Width))
$px = ($W - $pw) / 2
$py = 402

for ($i = 26; $i -ge 1; $i--) {
    $alpha = [int](58 * [Math]::Pow(1 - ($i / 26.0), 2.2))
    if ($alpha -le 0) { continue }
    $halo = New-RoundedPath ($px - $i) ($py - $i) ($pw + 2 * $i) ($ph + 2 * $i) (12 + $i)
    $pen = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb($alpha, $PINK.R, $PINK.G, $PINK.B), 2)
    $g.DrawPath($pen, $halo)
    $pen.Dispose()
    $halo.Dispose()
}

$clip = New-RoundedPath $px $py $pw $ph 12
$g.SetClip($clip)
$g.DrawImage($img, [single]$px, [single]$py, [single]$pw, [single]$ph)
$g.ResetClip()
$edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, $PINK.R, $PINK.G, $PINK.B), 3)
$g.DrawPath($edge, $clip)
$img.Dispose()

# --- Bottom bar --------------------------------------------------------------
$featFont = New-Object System.Drawing.Font('Segoe UI Semibold', 25, [System.Drawing.FontStyle]::Bold)
Write-Centered 'REAL-TIME  ·  DIAL = VOLUME  ·  PRESS = PLAY / PAUSE' `
    $featFont ([System.Drawing.Color]::FromArgb(0xd6, 0xda, 0xe8)) 726 | Out-Null

$footFont = New-Object System.Drawing.Font('Segoe UI', 21)
Write-Centered 'Requires a Stream Deck + and YouTube Music Desktop' `
    $footFont ([System.Drawing.Color]::FromArgb(0x70, 0x76, 0x8c)) 828 | Out-Null

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$i = Get-Item $out
"  {0}  {1}x{2}  {3} KB" -f $i.Name, $W, $H, [math]::Round($i.Length / 1KB, 1)
