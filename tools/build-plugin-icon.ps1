# Generates icons/plugin.png (256) and icons/plugin@2x.png (512) from the
# geometry of icons/plugin.svg.
#
# The Marketplace requires PNG for the plugin icon (256 and 512), while action
# list and category icons accept SVG directly. Rather than pull in an SVG
# rasteriser as a build dependency, the drawing is reproduced here with
# System.Drawing in the same 256x256 coordinate space as the SVG.
#
# NOTE: this means the geometry lives in two places. If you change the SVG,
# mirror the change here.

Add-Type -AssemblyName System.Drawing

$icons = Join-Path $PSScriptRoot '..\src\dev.74nu5.ytmdstrip.sdPlugin\icons'
$icons = [System.IO.Path]::GetFullPath($icons)

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

function Write-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    # Everything is drawn in the SVG 256x256 space, then scaled.
    $g.ScaleTransform($size / 256.0, $size / 256.0)

    $bg = New-RoundedPath 0 0 256 256 56
    $g.FillPath((New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(0x12, 0x12, 0x1c))), $bg)

    $strip = New-RoundedPath 20 84 216 88 16
    $g.FillPath((New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(0x23, 0x23, 0x36))), $strip)

    # Dial separations: white at 13% opacity.
    $sep = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(33, 255, 255, 255), 2)
    foreach ($x in 74, 128, 182) { $g.DrawLine($sep, $x, 88, $x, 168) }

    # The wave, continuous across the separations.
    $wave = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(0xff, 0x2d, 0x55), 10)
    $wave.StartCap = 'Round'
    $wave.EndCap = 'Round'
    $wave.LineJoin = 'Round'
    # Explicitly typed array: otherwise PowerShell passes an Object[] and
    # DrawLines refuses the conversion.
    [System.Drawing.PointF[]]$points = @(
        (New-Object System.Drawing.PointF(34, 128)),
        (New-Object System.Drawing.PointF(58, 104)),
        (New-Object System.Drawing.PointF(82, 150)),
        (New-Object System.Drawing.PointF(106, 112)),
        (New-Object System.Drawing.PointF(128, 140)),
        (New-Object System.Drawing.PointF(152, 100)),
        (New-Object System.Drawing.PointF(176, 148)),
        (New-Object System.Drawing.PointF(200, 116)),
        (New-Object System.Drawing.PointF(222, 128))
    )
    $g.DrawLines($wave, $points)

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $i = Get-Item $path
    "  {0,-18} {1}x{1}  {2} KB" -f $i.Name, $size, [math]::Round($i.Length / 1KB, 1)
}

Write-Icon 256 (Join-Path $icons 'plugin.png')
Write-Icon 512 (Join-Path $icons 'plugin@2x.png')
