; Current-user Explorer verbs only. Never change default file associations.
!ifndef LOCALVIEW_CONTEXT_MENU_NSH
!define LOCALVIEW_CONTEXT_MENU_NSH
!include LogicLib.nsh

LangString LocalViewOpenFolder 1033 "Open with LocalView"
LangString LocalViewOpenFolder 2052 "用 LocalView 打开"

!macro LOCALVIEW_REGISTER_FOLDER KEY ARG
  WriteRegStr HKCU "${KEY}" "" "$(LocalViewOpenFolder)"
  WriteRegStr HKCU "${KEY}" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "${KEY}" "MultiSelectModel" "Single"
  WriteRegStr HKCU "${KEY}" "LocalViewOwner" "$INSTDIR\${MAINBINARYNAME}.exe"
  ; The final dot prevents a drive-root trailing backslash escaping the quote.
  ; argument_to_path canonicalizes this before checking workspace boundaries.
  WriteRegStr HKCU "${KEY}\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"${ARG}\.$\"'
!macroend

!macro LOCALVIEW_REMOVE_FOLDER KEY ARG
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${KEY}" "LocalViewOwner"
  ReadRegStr $1 HKCU "${KEY}\command" ""
  ; A stale uninstaller must not remove another installation's registration.
  ${If} $0 == "$INSTDIR\${MAINBINARYNAME}.exe"
  ${AndIf} $1 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"${ARG}\.$\"'
    DeleteRegKey HKCU "${KEY}"
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  !insertmacro LOCALVIEW_REGISTER_FOLDER "Software\Classes\Directory\shell\LocalView.Open" "%1"
  !insertmacro LOCALVIEW_REGISTER_FOLDER "Software\Classes\Directory\Background\shell\LocalView.Open" "%V"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetRegView 64
  !insertmacro LOCALVIEW_REMOVE_FOLDER "Software\Classes\Directory\shell\LocalView.Open" "%1"
  !insertmacro LOCALVIEW_REMOVE_FOLDER "Software\Classes\Directory\Background\shell\LocalView.Open" "%V"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
!endif
