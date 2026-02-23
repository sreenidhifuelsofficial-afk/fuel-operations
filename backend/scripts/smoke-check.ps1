param(
  [string]$BaseUrl = $(if ($env:FUEL_OPS_BASE_URL) { $env:FUEL_OPS_BASE_URL } else { 'http://127.0.0.1:5000' }),
  [string]$Identifier = $(if ($env:FUEL_OPS_IDENTIFIER) { $env:FUEL_OPS_IDENTIFIER } else { 'owner@local.test' }),
  [string]$Password = $(if ($env:FUEL_OPS_PASSWORD) { $env:FUEL_OPS_PASSWORD } else { 'Owner@123' })
)

$ErrorActionPreference = 'Stop'

$base = $BaseUrl
$today = (Get-Date).ToString('yyyy-MM-dd')

function Api {
  param(
    [Parameter(Mandatory=$true)][string]$Method,
    [Parameter(Mandatory=$true)][string]$Path,
    [string]$Token,
    $Body
  )

  $headers = @{ Accept = 'application/json' }
  if ($Token) { $headers.Authorization = 'Bearer ' + $Token }

  $uri = $base + $Path

  if ($null -ne $Body) {
    $headers.'Content-Type' = 'application/json'
    $json = $Body | ConvertTo-Json -Depth 20
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
  }

  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
}

Write-Host "Base: $base"
Write-Host "Date: $today"

# 1) Login
$login = Api -Method 'POST' -Path '/api/auth/login' -Body @{ identifier = $Identifier; password = $Password }
$token = $login.token
Write-Host "Logged in as: $($login.user.email) role=$($login.user.role)"

# 1b) Create a temp TRUCK vehicle and a lot, then delete vehicle via /vehicles/:id
$vehRnd = Get-Random -Maximum 999999
$veh = Api -Method 'POST' -Path '/api/fuel-ops/storage-units' -Token $token -Body @{ unit_type='TRUCK'; unit_code=('SMOKE-TRUCK-' + $vehRnd); capacity_liters=1000; vehicle_number=('SMK-' + $vehRnd) }
$vehId = [int]$veh.id
Write-Host "Created temp vehicle(TRUCK) id=$vehId code=$($veh.unit_code)"

$vehLot = Api -Method 'POST' -Path '/api/fuel-ops/lots' -Token $token -Body @{ unit_id=$vehId; load_date=$today; loaded_liters=5.000; load_time='08:30' }
Write-Host "Created vehicle lot code=$($vehLot.lot_code)"

$delVeh = Api -Method 'DELETE' -Path ("/api/fuel-ops/vehicles/$vehId") -Token $token
Write-Host "Vehicle delete response: $($delVeh | ConvertTo-Json -Compress)"

# 2) Pick a TRUCK
$trucks = Api -Method 'GET' -Path '/api/fuel-ops/vehicles?type=TRUCK' -Token $token
if (-not $trucks -or $trucks.Count -lt 1) { throw 'No TRUCK units found' }
$truck = $trucks | Select-Object -First 1
$truckId = [int]$truck.id
$truckCode = $truck.unit_code
Write-Host "Using TRUCK id=$truckId code=$truckCode"

# 3) Create driver
$driverPayload = @{ driver_id = ('SMOKE' + (Get-Random -Maximum 9999)); name = 'Smoke Driver' }
$driver = Api -Method 'POST' -Path '/api/fuel-ops/drivers' -Token $token -Body $driverPayload
$driverId = [int]$driver.id
Write-Host "Created driver id=$driverId code=$($driver.driver_id)"

# 4) Create two DATUM units
$datum1 = Api -Method 'POST' -Path '/api/fuel-ops/storage-units' -Token $token -Body @{ unit_type='DATUM'; unit_code=('SMOKE-DATUM-A-' + (Get-Random -Maximum 9999)); capacity_liters=500 }
$datum2 = Api -Method 'POST' -Path '/api/fuel-ops/storage-units' -Token $token -Body @{ unit_type='DATUM'; unit_code=('SMOKE-DATUM-B-' + (Get-Random -Maximum 9999)); capacity_liters=500 }
$datum1Id = [int]$datum1.id
$datum2Id = [int]$datum2.id
Write-Host "Created datum1 id=$datum1Id code=$($datum1.unit_code)"
Write-Host "Created datum2 id=$datum2Id code=$($datum2.unit_code)"

# 5) Create a purchase lot so we can record ops
$lotPayload = @{ unit_id=$truckId; load_date=$today; loaded_liters=50.000; load_time='09:00' }
$lot = Api -Method 'POST' -Path '/api/fuel-ops/lots' -Token $token -Body $lotPayload
Write-Host "Created lot code=$($lot.lot_code)"

# 6) Create 1.234L SALE
$sale = Api -Method 'POST' -Path '/api/fuel-ops/lots/activity' -Token $token -Body @{ activity='TANKER_TO_VEHICLE'; from_unit_id=$truckId; to_vehicle='SMOKE-VEH-1234'; volume_liters=1.234; sale_date=$today; performed_time='10:01'; driver_id=$driverId; driver_name='Smoke Driver' }
Write-Host "SALE recorded sale_volume_liters=$($sale.sale.sale_volume_liters)"

# 7) Create 1.234L INTERNAL TRANSFER to datum1
$xfer = Api -Method 'POST' -Path '/api/fuel-ops/lots/activity' -Token $token -Body @{ activity='TANKER_TO_DATUM'; from_unit_id=$truckId; to_unit_id=$datum1Id; volume_liters=1.234; transfer_date=$today; performed_time='10:02'; driver_id=$driverId; driver_name='Smoke Driver' }
$xferVol = $null
if ($xfer.transfers -and $xfer.transfers.Count -ge 1) { $xferVol = $xfer.transfers[0].transfer_volume }
Write-Host "XFER recorded total_transferred=$($xfer.total_transferred) first_transfer_volume=$xferVol"

# 8) Create 1.234L TESTING (net-zero)
$test = Api -Method 'POST' -Path '/api/fuel-ops/lots/activity' -Token $token -Body @{ activity='TESTING'; from_unit_id=$truckId; to_vehicle=$truckCode; volume_liters=1.234; transfer_date=$today; performed_time='10:03'; driver_id=$driverId; driver_name='Smoke Driver' }
Write-Host "TEST recorded (check via ops/day testing list)"

# 9) Fetch ops/day and confirm volumes
$ops = Api -Method 'GET' -Path ("/api/fuel-ops/ops/day?truck_id=$truckId&date=$today") -Token $token
$saleRow = $ops.sales | Where-Object { $_.to_vehicle -eq 'SMOKE-VEH-1234' -and $_.performed_time -eq '10:01' } | Select-Object -Last 1
$xferRow = $ops.transfers_out | Where-Object { [int]$_.to_unit_id -eq $datum1Id -and ($_.transfer_time.ToString().Substring(0,5) -eq '10:02') } | Select-Object -Last 1
$testRow = $ops.testing | Where-Object {
  try {
    ([DateTime]$_.performed_at).ToString('HH:mm') -eq '10:03'
  } catch { $false }
} | Select-Object -Last 1

if (-not $saleRow) { throw 'Could not find the sale row in ops/day' }
if (-not $xferRow) { throw 'Could not find the internal transfer row in ops/day' }
if (-not $testRow) { throw 'Could not find the testing row in ops/day' }

Write-Host "OPS/day SALE sale_volume_liters=$($saleRow.sale_volume_liters)"
Write-Host "OPS/day XFER_OUT transfer_volume=$($xferRow.transfer_volume)"
Write-Host "OPS/day TEST testing_volume_liters=$($testRow.testing_volume_liters)"

foreach ($v in @($saleRow.sale_volume_liters, $xferRow.transfer_volume, $testRow.testing_volume_liters)) {
  if ([decimal]$v -ne [decimal]1.234) { throw "Expected 1.234, got $v" }
}
Write-Host "✅ Persisted volumes match 1.234"

# 10) Delete driver
$delDriver = Api -Method 'DELETE' -Path ("/api/fuel-ops/drivers/$driverId") -Token $token
Write-Host "Driver delete response: $($delDriver | ConvertTo-Json -Compress)"

# 11) Delete datum2 (unused)
$delDatum2 = Api -Method 'DELETE' -Path ("/api/fuel-ops/storage-units/$datum2Id") -Token $token
Write-Host "Datum2 delete response: $($delDatum2 | ConvertTo-Json -Compress)"

# 12) Delete datum1 (referenced)
$delDatum1 = Api -Method 'DELETE' -Path ("/api/fuel-ops/storage-units/$datum1Id") -Token $token
Write-Host "Datum1 delete response: $($delDatum1 | ConvertTo-Json -Compress)"

Write-Host "SMOKE CHECK COMPLETE"