DocuFast Agent — Pendrive Shop Setup
=====================================

WHAT THIS DOES
--------------
Running install.bat on a shop's PC will, in one go:
  1. Install SumatraPDF (silently, no clicks needed)
  2. Install DocuFast Agent (silently, no setup wizard)
  3. Write the shop's API key + printer path directly into the app's config
  4. Launch the app

The technician only has to type the shop's API key once when prompted.
Everything else is automatic.


ONE-TIME SETUP OF THE PENDRIVE (do this once, on any PC)
----------------------------------------------------------
Put these 4 files in the SAME folder on the pendrive:

  install.bat                        <- included here
  install.ps1                        <- included here
  SumatraPDF-installer.exe           <- you download this once (see below)
  DocuFast Agent Setup X.X.X.exe     <- the latest build (copy it in)

To get SumatraPDF-installer.exe:
  1. Go to https://www.sumatrapdfreader.org/download-free-pdf-viewer
  2. Download the regular installer (NOT the "portable" zip version)
  3. Rename the downloaded file to exactly: SumatraPDF-installer.exe
  4. Put it in the pendrive folder next to install.bat

Whenever you rebuild a newer version of the app, just replace the
"DocuFast Agent Setup X.X.X.exe" file on the pendrive with the new one —
nothing else needs to change.


AT THE SHOP
------------
1. Plug in the pendrive on the shop's PC.
2. Open the folder, double-click install.bat.
   (Windows may show a blue "Windows protected your PC" SmartScreen
   warning since the app isn't code-signed — click "More info" then
   "Run anyway". This is expected and safe.)
3. When prompted, paste that shop's API key (get it from the owner
   dashboard's shop list — click "Link / QR" next to the shop, the key
   isn't shown there directly, so keep it handy from wherever you noted
   it down when the shop was created).
4. Wait for it to finish — it prints progress as it goes.
5. Check the tray icon near the clock shows "Connected".
6. Print a test job from that shop's own QR code / link to confirm
   everything actually works end to end.


TROUBLESHOOTING
-----------------
"SumatraPDF-installer.exe not found"
  -> You forgot to put it on the pendrive. See "ONE-TIME SETUP" above.

"No 'DocuFast Agent Setup*.exe' found"
  -> Same idea — copy the installer file onto the pendrive next to
     install.bat. The filename must start with "DocuFast Agent Setup".

Tray shows "Disconnected" after setup
  -> Wrong or expired shop key. Open the dashboard (double-click the
     tray icon) -> Settings -> re-check the key, or re-run install.bat
     with the correct key (it's safe to run again).

Script closes instantly / does nothing
  -> Right-click install.bat -> Run as administrator isn't required
     (the app runs fine as a normal user), but if antivirus is
     blocking script execution, try running install.ps1 directly via
     right-click -> Run with PowerShell instead.
