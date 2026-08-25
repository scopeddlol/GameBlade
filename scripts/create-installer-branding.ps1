<#
.SYNOPSIS
Creates the bitmap assets used by GameBlade's branded NSIS installer.

.DESCRIPTION
Tauri/NSIS requires BMP files at fixed dimensions for its header and welcome/
finish sidebar. Keeping the generator in source control makes those assets
repeatable whenever the installer branding changes.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$assetRoot = Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\installer-assets'
New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null

Add-Type -AssemblyName System.Drawing

function New-BrandBackground([int]$Width, [int]$Height) {
    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $bounds = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
    $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $bounds,
        [System.Drawing.Color]::FromArgb(11, 13, 23),
        [System.Drawing.Color]::FromArgb(41, 24, 83),
        55
    )
    $graphics.FillRectangle($background, $bounds)
    $background.Dispose()

    $orb = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(72, 124, 92, 255))
    $graphics.FillEllipse($orb, [System.Drawing.Rectangle]::new([int]($Width * .32), [int]($Height * .05), [int]($Width * .9), [int]($Width * .9)))
    $orb.Dispose()
    return @{ Bitmap = $bitmap; Graphics = $graphics }
}

function Save-Header {
    $canvas = New-BrandBackground 150 57
    $g = $canvas.Graphics
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(180, 167, 139, 250))
    $font = [System.Drawing.Font]::new('Segoe UI Semibold', 15, [System.Drawing.FontStyle]::Bold)
    $small = [System.Drawing.Font]::new('Segoe UI', 6.5)
    $g.DrawString('GAMEBLADE', $font, $brush, 10, 10)
    $g.DrawString('YOUR LIBRARY. YOUR WAY.', $small, $accent, 11, 34)
    $font.Dispose(); $small.Dispose(); $brush.Dispose(); $accent.Dispose(); $g.Dispose()
    $canvas.Bitmap.Save((Join-Path $assetRoot 'nsis-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
    $canvas.Bitmap.Dispose()
}

function Save-Sidebar {
    $canvas = New-BrandBackground 164 314
    $g = $canvas.Graphics
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(205, 211, 199, 255))
    $title = [System.Drawing.Font]::new('Segoe UI Semibold', 19, [System.Drawing.FontStyle]::Bold)
    $sub = [System.Drawing.Font]::new('Segoe UI', 8.5)
    $g.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(124, 92, 255)), 12, 28, 7, 54)
    $g.DrawString('GAME', $title, $white, 27, 27)
    $g.DrawString('BLADE', $title, $white, 27, 51)
    $g.DrawString('A home for your games.', $sub, $muted, 15, 105)
    $g.DrawString('Preserve. Play. Progress.', $sub, $muted, 15, 120)
    $title.Dispose(); $sub.Dispose(); $white.Dispose(); $muted.Dispose(); $g.Dispose()
    $canvas.Bitmap.Save((Join-Path $assetRoot 'nsis-sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
    $canvas.Bitmap.Dispose()
}

Save-Header
Save-Sidebar
