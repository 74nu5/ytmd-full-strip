# Genere icons/plugin.png (256) et icons/plugin@2x.png (512) a partir de la
# geometrie de icons/plugin.svg.
#
# Le Marketplace exige du PNG pour l'icone du plugin (256 et 512), alors que les
# icones de liste et de categorie acceptent le SVG directement. Aucun rasteriseur
# SVG n'etant requis pour construire ce projet, le trace est reproduit ici avec
# System.Drawing dans le meme repere 256x256 que le SVG. Si tu modifies le SVG,
# reporte le changement ici.

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
    # Tout est trace dans le repere 256x256 du SVG, puis mis a l'echelle.
    $g.ScaleTransform($size / 256.0, $size / 256.0)

    $bg = New-RoundedPath 0 0 256 256 56
    $g.FillPath((New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(0x12, 0x12, 0x1c))), $bg)

    $strip = New-RoundedPath 20 84 216 88 16
    $g.FillPath((New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(0x23, 0x23, 0x36))), $strip)

    # Separations entre encodeurs : blanc a 13 % d'opacite.
    $sep = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(33, 255, 255, 255), 2)
    foreach ($x in 74, 128, 182) { $g.DrawLine($sep, $x, 88, $x, 168) }

    # L'onde, continue par-dessus les separations.
    $wave = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(0xff, 0x2d, 0x55), 10)
    $wave.StartCap = 'Round'
    $wave.EndCap = 'Round'
    $wave.LineJoin = 'Round'
    # Tableau explicitement type : sinon PowerShell passe un Object[] et
    # DrawLines refuse la conversion.
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
