# A window with one big button, for the Computer Use tests: it stays on top, in the middle of the primary monitor, writes its
# button's screen rectangle to <out>.bounds.json at start and, when the button is clicked, writes where the pointer was to <out>.
#   powershell -NoProfile -STA -File click-target.ps1 -Out <file> [-Seconds 600]
param([Parameter(Mandatory = $true)][string]$Out, [int]$Seconds = 600)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Alvo do teste do Openclod'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedToolWindow'
$form.ClientSize = New-Object System.Drawing.Size 520, 300
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point ([int]($area.X + ($area.Width - 520) / 2)), ([int]($area.Y + ($area.Height - 300) / 2))
$form.BackColor = [System.Drawing.Color]::White
$button = New-Object System.Windows.Forms.Button
$button.Text = 'CLIQUE AQUI'
$button.Font = New-Object System.Drawing.Font 'Segoe UI', 20, ([System.Drawing.FontStyle]::Bold)
$button.ForeColor = [System.Drawing.Color]::White
$button.BackColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
$button.FlatStyle = 'Flat'
$button.Size = New-Object System.Drawing.Size 300, 120
$button.Location = New-Object System.Drawing.Point 110, 90
$form.Controls.Add($button)
$button.Add_Click({
  $p = [System.Windows.Forms.Cursor]::Position
  $json = '{"clicked":true,"x":' + $p.X + ',"y":' + $p.Y + ',"at":"' + (Get-Date).ToString('o') + '"}'
  [System.IO.File]::WriteAllText($Out, $json)
  $button.Text = 'OK!'
  $button.BackColor = [System.Drawing.Color]::FromArgb(22, 163, 74)
})
$form.Add_Shown({
  $r = $button.RectangleToScreen($button.ClientRectangle)
  $json = '{"x":' + $r.X + ',"y":' + $r.Y + ',"width":' + $r.Width + ',"height":' + $r.Height + '}'
  [System.IO.File]::WriteAllText("$Out.bounds.json", $json)
  $form.Activate()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
