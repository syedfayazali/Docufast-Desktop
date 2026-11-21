; Runs first when the installer starts. DocuFast lives in the tray, so a closed window does not mean
; it has stopped; a running copy locks its files and makes "Failed to uninstall old application files".
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "DocuFast.exe"'
  Pop $0
  Sleep 1500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "DocuFast.exe"'
  Pop $0
  Sleep 1000
!macroend
