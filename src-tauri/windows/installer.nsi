; LUCANIA: template NSIS personnalisé (bundle.windows.nsis.template), basé sur le template officiel
; LUCANIA: de tauri-bundler au tag tauri-cli-v2.12.1 (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi).
; LUCANIA: chaque modification est marquée « ; LUCANIA: ». Objet : si une installation existante est
; LUCANIA: détectée, une seule page (Mettre à jour / Mettre à jour proprement), les données utilisateur
; LUCANIA: (%APPDATA% et %LOCALAPPDATA%\${BUNDLEID}) n'étant JAMAIS supprimées par l'installateur.
Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
; LUCANIA: variables de la page « déjà installé » et de la mise à jour propre
Var LucaniaExisting          ; 1 si une installation NSIS existante (hors WiX) est détectée dans .onInit
Var LucaniaInstalledVersion  ; version installée (affichée sur la page)
Var LucaniaOldDir            ; ancien dossier d'installation (lu dans le registre)
Var LucaniaOldDirHadExe      ; 1 si l'ancien dossier contenait ${MAINBINARYNAME}.exe avant désinstallation
Var LucaniaRestoreDesktopLnk ; 1 si un raccourci Bureau existait (il est recréé après réinstallation)
Var LucaniaTmp

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
; LUCANIA: page sautée aussi si une installation existante est détectée
!define MUI_PAGE_CUSTOMFUNCTION_PRE LucaniaSkipIfPassiveOrExisting
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  ; LUCANIA: page sautée aussi si une installation existante est détectée
  !define MUI_PAGE_CUSTOMFUNCTION_PRE LucaniaSkipIfPassiveOrExisting
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}
  ; LUCANIA: mémorise la version installée pour l'afficher
  StrCpy $LucaniaInstalledVersion $R0
  ${IfThen} $LucaniaInstalledVersion == "" ${|} StrCpy $LucaniaInstalledVersion "$(lucaniaUnknownVersion)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0

  ; LUCANIA: hors WiX, page simplifiée à deux choix (voir LucaniaPageReinstall) au lieu de la page d'origine
  ${If} $WixMode <> 1
    Call LucaniaPageReinstall
    Return
  ${EndIf}
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; LUCANIA: hors WiX (seul cas restant ici), quelle que soit la version installée :
  ; LUCANIA: 1er choix ($R1 = 1) = « Mettre à jour / Réinstaller » : par-dessus, sans désinstaller ;
  ; LUCANIA: 2e choix = « ... proprement » : désinstallation de l'ancien programme puis réinstallation.
  ; LUCANIA: En mode passif (pas de page) : mise à jour simple, sauf retour arrière interdit.
  ${If} $PassiveMode = 1
    StrCpy $R1 1
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} StrCpy $R1 0 ${|}
    !endif
  ${EndIf}
  ${If} $R1 = 1
    Goto reinst_done
  ${Else}
    Goto reinst_uninstall
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ; LUCANIA: mémorise l'ancien dossier, la présence de l'exe et du raccourci Bureau AVANT désinstallation
      Call LucaniaBeforeCleanUninstall
      ClearErrors ; LUCANIA: l'appel ci-dessus ne doit pas fausser le test d'erreur après ExecWait
      ; LUCANIA: TOUJOURS /UPDATE et /P (le template d'origine ne mettait /UPDATE que si l'installateur
      ; LUCANIA: avait lui-même été lancé avec /UPDATE). /UPDATE est le seul drapeau que l'ancien
      ; LUCANIA: désinstallateur déjà installé (0.0.1) connaît : il saute alors la suppression des données
      ; LUCANIA: (case du template et hook NSIS_HOOK_POSTUNINSTALL) mais supprime bien les fichiers du
      ; LUCANIA: programme et la clé de désinstallation. /P = mode passif (pas de confirmation).
      StrCpy $R1 "$R1 /UPDATE /P"
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}

    ; LUCANIA: après la désinstallation propre : suppression des raccourcis (sautée par /UPDATE côté
    ; LUCANIA: désinstallateur), de la clé du dossier d'installation et des fichiers résiduels.
    ${If} $WixMode <> 1
      Call LucaniaAfterCleanUninstall
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
; LUCANIA: page sautée aussi si une installation existante est détectée (on garde le dossier
; LUCANIA: existant, restauré depuis le registre par RestorePreviousInstallLocation dans .onInit)
!define MUI_PAGE_CUSTOMFUNCTION_PRE LucaniaSkipIfPassiveOrExisting
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  ; LUCANIA: page sautée aussi si une installation existante est détectée
  !define MUI_PAGE_CUSTOMFUNCTION_PRE LucaniaSkipIfPassiveOrExisting
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
; LUCANIA: en mise à jour, la case « raccourci Bureau » est décochée puis masquée (voir LucaniaFinishShow)
!define MUI_PAGE_CUSTOMFUNCTION_SHOW LucaniaFinishShow
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; LUCANIA: textes de la page « déjà installé » (bundle.windows.nsis.languages = French, English ;
; LUCANIA: langue choisie automatiquement selon celle de Windows). $LucaniaInstalledVersion est
; LUCANIA: remplacé à l'exécution par la version installée.
!ifdef LANG_FRENCH
LangString lucaniaUnknownVersion ${LANG_FRENCH} "version inconnue"
LangString lucaniaHeaderTitle ${LANG_FRENCH} "${PRODUCTNAME} est déjà installé"
LangString lucaniaHeaderUpdate ${LANG_FRENCH} "Choisissez comment mettre à jour ${PRODUCTNAME}."
LangString lucaniaHeaderReinstall ${LANG_FRENCH} "Choisissez comment réinstaller ${PRODUCTNAME}."
LangString lucaniaOlderInstalled ${LANG_FRENCH} "Une version antérieure de ${PRODUCTNAME} ($LucaniaInstalledVersion) est installée sur cet ordinateur. Choisissez comment installer la version ${VERSION}, puis cliquez sur Installer."
LangString lucaniaSameInstalled ${LANG_FRENCH} "${PRODUCTNAME} $LucaniaInstalledVersion est déjà installé sur cet ordinateur (même version que celle-ci). Choisissez une option, puis cliquez sur Installer."
LangString lucaniaNewerInstalled ${LANG_FRENCH} "Une version plus récente de ${PRODUCTNAME} ($LucaniaInstalledVersion) est installée sur cet ordinateur. Ce programme d'installation contient la version ${VERSION}. Choisissez une option, puis cliquez sur Installer."
LangString lucaniaUpdate ${LANG_FRENCH} "Mettre à jour (recommandé)"
LangString lucaniaUpdateClean ${LANG_FRENCH} "Mettre à jour proprement"
LangString lucaniaReinstall ${LANG_FRENCH} "Réinstaller (recommandé)"
LangString lucaniaReinstallClean ${LANG_FRENCH} "Réinstaller proprement"
LangString lucaniaSimpleDesc ${LANG_FRENCH} "Installe la version ${VERSION} par-dessus celle déjà présente. Rapide, rien n'est supprimé."
LangString lucaniaCleanDesc ${LANG_FRENCH} "Réinstalle le programme à neuf : l'ancien programme est d'abord supprimé. Vos conversations et vos réglages sont conservés. Utile si l'application fonctionne mal."
!endif

!ifdef LANG_ENGLISH
LangString lucaniaUnknownVersion ${LANG_ENGLISH} "unknown version"
LangString lucaniaHeaderTitle ${LANG_ENGLISH} "${PRODUCTNAME} is already installed"
LangString lucaniaHeaderUpdate ${LANG_ENGLISH} "Choose how to update ${PRODUCTNAME}."
LangString lucaniaHeaderReinstall ${LANG_ENGLISH} "Choose how to reinstall ${PRODUCTNAME}."
LangString lucaniaOlderInstalled ${LANG_ENGLISH} "An older version of ${PRODUCTNAME} ($LucaniaInstalledVersion) is installed on this computer. Choose how to install version ${VERSION}, then click Install."
LangString lucaniaSameInstalled ${LANG_ENGLISH} "${PRODUCTNAME} $LucaniaInstalledVersion is already installed on this computer (same version as this one). Choose an option, then click Install."
LangString lucaniaNewerInstalled ${LANG_ENGLISH} "A newer version of ${PRODUCTNAME} ($LucaniaInstalledVersion) is installed on this computer. This installer contains version ${VERSION}. Choose an option, then click Install."
LangString lucaniaUpdate ${LANG_ENGLISH} "Update (recommended)"
LangString lucaniaUpdateClean ${LANG_ENGLISH} "Clean update"
LangString lucaniaReinstall ${LANG_ENGLISH} "Reinstall (recommended)"
LangString lucaniaReinstallClean ${LANG_ENGLISH} "Clean reinstall"
LangString lucaniaSimpleDesc ${LANG_ENGLISH} "Installs version ${VERSION} over the existing one. Quick, nothing is removed."
LangString lucaniaCleanDesc ${LANG_ENGLISH} "Reinstalls the program from scratch: the old program is removed first. Your conversations and settings are kept. Useful if the app is not working properly."
!endif

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; LUCANIA: détection précoce d'une installation existante (pour sauter les pages)
  Call LucaniaDetectExisting
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; LUCANIA: mise à jour propre : recrée le raccourci Bureau s'il existait avant la désinstallation
  ${If} $LucaniaRestoreDesktopLnk = 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd

; ---------------------------------------------------------------------------------------------
; LUCANIA: fonctions ajoutées (page « déjà installé », mise à jour propre, garde-fous)
; ---------------------------------------------------------------------------------------------

; LUCANIA: comme SkipIfPassive, mais saute aussi la page si une installation existante est détectée
Function LucaniaSkipIfPassiveOrExisting
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  ${IfThen} $LucaniaExisting = 1 ${|} Abort ${|}
FunctionEnd

; LUCANIA: page de fin : en mise à jour ($LucaniaExisting = 1), la case « raccourci Bureau » est
; LUCANIA: décochée (la fonction SHOWREADME n'est alors pas appelée à la sortie de la page) puis masquée.
Function LucaniaFinishShow
  ${If} $LucaniaExisting = 1
    ${NSD_Uncheck} $mui.FinishPage.ShowReadme
    ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
  ${EndIf}
FunctionEnd

; LUCANIA: détection (dans .onInit) d'une installation NSIS existante, avec les mêmes critères que
; LUCANIA: PageReinstall. Une installation WiX détectée garde le parcours d'origine ($LucaniaExisting = 0).
Function LucaniaDetectExisting
  Push $0
  Push $1
  Push $R0
  Push $R1
  StrCpy $LucaniaExisting 0
  StrCpy $0 0
  lucania_wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" lucania_wix_loop_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 lucania_wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 lucania_detect_done lucania_wix_loop_done ; WiX : parcours d'origine
  lucania_wix_loop_done:
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" != "" ${|} StrCpy $LucaniaExisting 1 ${|}
  lucania_detect_done:
  Pop $R1
  Pop $R0
  Pop $1
  Pop $0
FunctionEnd

; LUCANIA: page « déjà installé » (hors WiX), appelée par PageReinstall avec
; LUCANIA: $R0 = 1 (version installée plus ancienne ou inconnue), 0 (même version), -1 (plus récente).
; LUCANIA: Utilise les mêmes registres que la page d'origine ($R2/$R3 = boutons radio) pour que
; LUCANIA: PageLeaveReinstall et PageReinstallUpdateSelection fonctionnent sans changement.
Function LucaniaPageReinstall
  ${If} $R0 = 0
    StrCpy $R1 "$(lucaniaSameInstalled)"
    StrCpy $R2 "$(lucaniaReinstall)"
    StrCpy $R3 "$(lucaniaReinstallClean)"
    !insertmacro MUI_HEADER_TEXT "$(lucaniaHeaderTitle)" "$(lucaniaHeaderReinstall)"
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(lucaniaNewerInstalled)"
    StrCpy $R2 "$(lucaniaReinstall)"
    StrCpy $R3 "$(lucaniaReinstallClean)"
    !insertmacro MUI_HEADER_TEXT "$(lucaniaHeaderTitle)" "$(lucaniaHeaderReinstall)"
  ${Else}
    StrCpy $R1 "$(lucaniaOlderInstalled)"
    StrCpy $R2 "$(lucaniaUpdate)"
    StrCpy $R3 "$(lucaniaUpdateClean)"
    !insertmacro MUI_HEADER_TEXT "$(lucaniaHeaderTitle)" "$(lucaniaHeaderUpdate)"
  ${EndIf}

  ; Mode passif, ou /UPDATE (le choix serait de toute façon ignoré) : pas de page
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Call PageLeaveReinstall
    Return
  ${EndIf}

  nsDialogs::Create 1018
  Pop $R4
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 30u $R1
  Pop $R1

  ${NSD_CreateRadioButton} 10u 38u -10u 10u $R2
  Pop $R2
  ${NSD_OnClick} $R2 PageReinstallUpdateSelection
  ${NSD_CreateLabel} 23u 50u -23u 18u "$(lucaniaSimpleDesc)"
  Pop $R5

  ${NSD_CreateRadioButton} 10u 74u -10u 10u $R3
  Pop $R3
  ${NSD_OnClick} $R3 PageReinstallUpdateSelection
  ${NSD_CreateLabel} 23u 86u -23u 28u "$(lucaniaCleanDesc)"
  Pop $R5

  ; Retour arrière interdit : seule la réinstallation propre est possible
  !if "${ALLOWDOWNGRADES}" == "false"
    ${If} $R0 = -1
      EnableWindow $R2 0
      StrCpy $ReinstallPageCheck 2
    ${EndIf}
  !endif

  ; 1er choix coché par défaut (ou le dernier choix si on revient sur la page après une erreur)
  ${If} $ReinstallPageCheck <> 2
    SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $R2
  ${Else}
    SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $R3
  ${EndIf}

  ; Bouton « Installer » au lieu de « Suivant » (c'est la seule page avant l'installation)
  GetDlgItem $LucaniaTmp $HWNDPARENT 1
  SendMessage $LucaniaTmp ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
  ; Pas de bouton « Précédent » : les pages précédentes sont sautées
  !if "${INSTALLMODE}" != "both"
    ${If} $LucaniaExisting = 1
      GetDlgItem $LucaniaTmp $HWNDPARENT 3
      EnableWindow $LucaniaTmp 0
    ${EndIf}
  !endif

  nsDialogs::Show
FunctionEnd

; LUCANIA: retire le « \ » final éventuel d'un chemin (VAR ne doit pas être $LucaniaTmp)
!macro LUCANIA_STRIP_TRAILING_SLASH VAR
  StrCpy $LucaniaTmp ${VAR} "" -1
  ${If} $LucaniaTmp == "\"
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
!macroend

; LUCANIA: avant la désinstallation propre (appelée avec $4 = ancien dossier lu dans le registre) :
; LUCANIA: mémorise le dossier, si ${MAINBINARYNAME}.exe s'y trouve, et si un raccourci Bureau y pointe.
Function LucaniaBeforeCleanUninstall
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $LucaniaOldDir $4
  !insertmacro LUCANIA_STRIP_TRAILING_SLASH $LucaniaOldDir
  StrCpy $LucaniaOldDirHadExe 0
  StrCpy $LucaniaRestoreDesktopLnk 0
  ${If} $LucaniaOldDir != ""
    ${If} ${FileExists} "$LucaniaOldDir\${MAINBINARYNAME}.exe"
      StrCpy $LucaniaOldDirHadExe 1
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$LucaniaOldDir\${MAINBINARYNAME}.exe"
    Pop $0
    ${IfThen} $0 = 1 ${|} StrCpy $LucaniaRestoreDesktopLnk 1 ${|}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; LUCANIA: après la désinstallation propre réussie (ancien désinstallateur lancé avec /UPDATE /P).
; LUCANIA: /UPDATE fait sauter côté désinstallateur la suppression des raccourcis : on la fait ici
; LUCANIA: (mêmes raccourcis que la section Uninstall du template ; les épinglages de la barre des
; LUCANIA: tâches ne sont pas retirés, ils pointent vers le même exe réinstallé). Puis suppression de
; LUCANIA: la clé du dossier d'installation et des fichiers résiduels (garde-fous stricts).
; LUCANIA: Les dossiers de données (%APPDATA% / %LOCALAPPDATA%\${BUNDLEID}) ne sont JAMAIS touchés.
Function LucaniaAfterCleanUninstall
  Push $0
  Push $1
  Push $2
  Push $3
  Push $R7
  Push $R8
  Push $R9

  ${If} $LucaniaOldDir != ""
    StrCpy $R8 "$LucaniaOldDir\${MAINBINARYNAME}.exe"

    ; Raccourcis du menu Démarrer (dossier éventuel puis racine)
    !insertmacro MUI_STARTMENU_GETFOLDER Application $R9
    ${If} $R9 != ""
      !insertmacro IsShortcutTarget "$SMPROGRAMS\$R9\${PRODUCTNAME}.lnk" "$R8"
      Pop $0
      ${If} $0 = 1
        Delete "$SMPROGRAMS\$R9\${PRODUCTNAME}.lnk"
        RMDir "$SMPROGRAMS\$R9"
      ${EndIf}
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$R8"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Raccourci du Bureau (recréé après réinstallation s'il existait, cf. $LucaniaRestoreDesktopLnk)
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$R8"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Clé du dossier d'installation (réécrite par la section Install)
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty SHCTX "${MANUKEY}"

  ; Fichiers résiduels de l'ancien dossier (ex. uninstall.exe, verrouillé pendant la désinstallation)
  ${If} $LucaniaOldDirHadExe = 1
    StrCpy $R8 $LucaniaOldDir
    Call LucaniaIsSafeToPurge
    ${If} $R7 = 1
      RMDir /r "$R8"
    ${EndIf}
  ${EndIf}

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; LUCANIA: $R8 = candidat, $R9 = autre chemin ; $R6 = 1 si $R8 est égal à $R9 ou en est un parent.
; LUCANIA: (comparaisons insensibles à la casse ; modifie $R8/$R9 en retirant le « \ » final)
Function LucaniaIsSameOrParent
  Push $R4
  Push $R5
  StrCpy $R6 0
  !insertmacro LUCANIA_STRIP_TRAILING_SLASH $R8
  !insertmacro LUCANIA_STRIP_TRAILING_SLASH $R9
  ${If} $R8 != ""
  ${AndIf} $R9 != ""
    ${If} $R8 == $R9
      StrCpy $R6 1
    ${Else}
      StrLen $R4 "$R8\"
      StrCpy $R5 $R9 $R4
      ${IfThen} $R5 == "$R8\" ${|} StrCpy $R6 1 ${|}
    ${EndIf}
  ${EndIf}
  Pop $R5
  Pop $R4
FunctionEnd

; LUCANIA: refuse ($R7 = 0) si le candidat $R8 est égal à PROTECTED ou en est un parent
!macro LUCANIA_REFUSE_SAME_OR_PARENT PROTECTED
  StrCpy $R9 "${PROTECTED}"
  Call LucaniaIsSameOrParent
  ${IfThen} $R6 = 1 ${|} StrCpy $R7 0 ${|}
!macroend

; LUCANIA: refuse ($R7 = 0) si le candidat $R8 est égal à PROTECTED ou se trouve à l'intérieur
!macro LUCANIA_REFUSE_INSIDE PROTECTED
  Push $R8
  StrCpy $R9 $R8
  StrCpy $R8 "${PROTECTED}"
  Call LucaniaIsSameOrParent
  Pop $R8
  ${IfThen} $R6 = 1 ${|} StrCpy $R7 0 ${|}
!macroend

; LUCANIA: garde-fous avant RMDir /r de l'ancien dossier d'installation.
; LUCANIA: Entrée $R8 (dossier, sans « \ » final), sortie $R7 = 1 si la suppression est autorisée.
; LUCANIA: L'appelant a déjà vérifié que le dossier contenait ${MAINBINARYNAME}.exe.
Function LucaniaIsSafeToPurge
  Push $R5
  Push $R6
  Push $R9
  StrCpy $R7 1

  ; Chemin local absolu « X:\... » (pas de racine de disque, pas de chemin réseau)
  StrLen $R5 $R8
  ${IfThen} $R5 <= 3 ${|} StrCpy $R7 0 ${|}
  StrCpy $R5 $R8 2 1
  ${IfThen} $R5 != ":\" ${|} StrCpy $R7 0 ${|}
  ; Pas de « .. », de nom court (~) ni de « / » (comparaisons de chemins fiables)
  ${StrLoc} $R5 $R8 ".." ">"
  ${IfThen} $R5 != "" ${|} StrCpy $R7 0 ${|}
  ${StrLoc} $R5 $R8 "~" ">"
  ${IfThen} $R5 != "" ${|} StrCpy $R7 0 ${|}
  ${StrLoc} $R5 $R8 "/" ">"
  ${IfThen} $R5 != "" ${|} StrCpy $R7 0 ${|}
  ; Le dossier doit porter le nom du produit (jamais un dossier partagé choisi à la main, ex. D:\Apps)
  ${GetFileName} $R8 $R5
  ${IfThen} $R5 != "${PRODUCTNAME}" ${|} StrCpy $R7 0 ${|}
  ; Le dossier doit exister
  ${IfNot} ${FileExists} "$R8\*.*"
    StrCpy $R7 0
  ${EndIf}

  ${If} $R7 = 1
    ; Ni égal ni parent d'un dossier système ou utilisateur
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$WINDIR"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$SYSDIR"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$PROGRAMFILES"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$PROGRAMFILES32"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$PROGRAMFILES64"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$COMMONFILES"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$COMMONFILES32"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$COMMONFILES64"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$TEMP"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$EXEDIR"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$PROFILE"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$DESKTOP"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$DOCUMENTS"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$SMPROGRAMS"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$APPDATA"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LOCALAPPDATA"
    ReadEnvStr $LucaniaTmp "ProgramW6432"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp"
    ReadEnvStr $LucaniaTmp "ProgramData"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp"
    ReadEnvStr $LucaniaTmp "PUBLIC"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp"
    ReadEnvStr $LucaniaTmp "USERPROFILE"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp"
    ; Dossiers de données de l'utilisateur courant : ni parent, ni égal, ni à l'intérieur
    ReadEnvStr $LucaniaTmp "APPDATA"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp\${BUNDLEID}"
    ReadEnvStr $LucaniaTmp "APPDATA"
    !insertmacro LUCANIA_REFUSE_INSIDE "$LucaniaTmp\${BUNDLEID}"
    ReadEnvStr $LucaniaTmp "LOCALAPPDATA"
    !insertmacro LUCANIA_REFUSE_SAME_OR_PARENT "$LucaniaTmp\${BUNDLEID}"
    ReadEnvStr $LucaniaTmp "LOCALAPPDATA"
    !insertmacro LUCANIA_REFUSE_INSIDE "$LucaniaTmp\${BUNDLEID}"
    ; Jamais à l'intérieur de Windows ni des profils utilisateurs (C:\Users\...)
    !insertmacro LUCANIA_REFUSE_INSIDE "$WINDIR"
    ReadEnvStr $LucaniaTmp "USERPROFILE"
    ${If} $LucaniaTmp != ""
      ${GetParent} $LucaniaTmp $LucaniaTmp
      !insertmacro LUCANIA_REFUSE_INSIDE "$LucaniaTmp"
    ${EndIf}
  ${EndIf}

  Pop $R9
  Pop $R6
  Pop $R5
FunctionEnd
