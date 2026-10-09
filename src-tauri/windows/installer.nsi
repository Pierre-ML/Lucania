; LUCANIA: template NSIS personnalisé (bundle.windows.nsis.template), basé sur le template officiel
; LUCANIA: de tauri-bundler au tag tauri-cli-v2.12.1 (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi).
; LUCANIA: chaque modification est marquée « ; LUCANIA: ». Ce template produit DEUX exe :
; LUCANIA:  - SETUP (rendu par tauri build, sans define) : première installation UNIQUEMENT. Si Lucania est
; LUCANIA:    déjà installé, message (utiliser l'exe de mise à jour) puis sortie dans .onInit.
; LUCANIA:  - UPDATE (même rendu recompilé par scripts/build-updater.mjs avec /DLUCANIA_UPDATER) : refuse si
; LUCANIA:    Lucania n'est pas installé ou si une version plus récente l'est ; sinon installe par-dessus
; LUCANIA:    l'installation existante (même dossier, pages Installation puis Fin seulement), ce qui répare
; LUCANIA:    aussi une installation abîmée. Rien n'est désinstallé.
; LUCANIA: Les données utilisateur (%APPDATA% et %LOCALAPPDATA%\${BUNDLEID}) ne sont JAMAIS touchées par
; LUCANIA: l'un ou l'autre ; seule une vraie désinstallation les supprime (hook NSIS_HOOK_POSTUNINSTALL).
; LUCANIA: Supprimés (code mort depuis ce découpage) : la page « déjà installé » (PageReinstall et la page
; LUCANIA: Lucania à deux choix), la « mise à jour propre » (désinstallation de l'ancien programme, nettoyage
; LUCANIA: manuel et ses garde-fous) et la migration depuis un ancien installateur WiX (Lucania n'a jamais
; LUCANIA: été distribué en MSI : bundle.targets = nsis seulement).
; LUCANIA: Mode d'installation : currentUser (bundle.windows.nsis.installMode) depuis la 0.1.12. Installation
; LUCANIA: pour l'utilisateur courant dans %LOCALAPPDATA%\Programs\${PRODUCTNAME}, sans droits administrateur
; LUCANIA: (RequestExecutionLevel user, SetShellVarContext current, SHCTX = HKCU) : l'antivirus (Norton)
; LUCANIA: bloquait l'écriture des exe non signés dans Program Files. Une ancienne installation
; LUCANIA: perMachine (Program Files, HKLM) est seulement signalée par le setup (LucaniaDetectLegacyMachineInstall) :
; LUCANIA: il n'a pas les droits pour y toucher et ne supprime rien.
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
; LUCANIA: ${StrCase} et ${StrLoc} retirés : ils ne servaient qu'à la détection WiX (supprimée) ;
; LUCANIA: les déclarer sans les utiliser provoque l'avertissement 6010 de makensis.

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
; LUCANIA: l'exe de mise à jour (/DLUCANIA_UPDATER) est écrit dans le fichier passé par
; LUCANIA: /DLUCANIA_UPDATE_OUT=<chemin> (scripts/build-updater.mjs), sinon à côté du setup rendu.
!ifdef LUCANIA_UPDATER
  !ifdef LUCANIA_UPDATE_OUT
    !define OUTFILE "${LUCANIA_UPDATE_OUT}"
  !else
    !define OUTFILE "nsis-output-update.exe"
  !endif
!else
  !define OUTFILE "{{out_file}}"
!endif
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
Var WixMode ; LUCANIA: toujours 0 (migration WiX supprimée, voir .onInit)
Var OldMainBinaryName
; LUCANIA: résultat de la détection d'une installation existante (LucaniaDetectInstall, dans .onInit)
Var LucaniaInstalled         ; 1 si Lucania est déjà installé (registre ou dossier existant)
Var LucaniaInstalledVersion  ; version installée (DisplayVersion, vide si inconnue)
Var LucaniaInstalledDir      ; dossier d'installation existant (sans guillemets ni « \ » final)
Var LucaniaTmp               ; brouillon
!ifndef LUCANIA_UPDATER
; LUCANIA: setup : dossier d'une ancienne installation perMachine (vide si aucune), voir
; LUCANIA: LucaniaDetectLegacyMachineInstall. Déclarée seulement dans le setup (avertissement 6001 sinon).
Var LucaniaLegacyDir
!endif

; LUCANIA: retire les guillemets de début et de fin d'un chemin lu dans le registre (ex. InstallLocation
; LUCANIA: est écrit "%LOCALAPPDATA%\Programs\Lucania" développé, AVEC guillemets). VAR ne doit pas être $LucaniaTmp.
; LUCANIA: Défini ici (et non avec les autres fonctions LUCANIA) car utilisé dès RestorePreviousInstallLocation.
!macro LUCANIA_UNQUOTE VAR
  StrCpy $LucaniaTmp ${VAR} 1
  ${If} $LucaniaTmp == "$\""
    StrCpy ${VAR} ${VAR} "" 1
  ${EndIf}
  StrCpy $LucaniaTmp ${VAR} "" -1
  ${If} $LucaniaTmp == "$\""
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
!macroend

; LUCANIA: double lancement (.onInit) : cherche une fenêtre de premier niveau de classe « #32770 » dont
; LUCANIA: le titre est exactement TITLE, ou TITLE suivi d'une espace (pages MUI2). $LucaniaTmp reçoit
; LUCANIA: le handle trouvé (0 sinon) ; ne cherche plus dès qu'une fenêtre a été trouvée.
!macro LUCANIA_FIND_INSTALLER_WINDOW TITLE
  ${If} $LucaniaTmp = 0
    FindWindow $LucaniaTmp "#32770" "${TITLE}"
  ${EndIf}
  ${If} $LucaniaTmp = 0
    FindWindow $LucaniaTmp "#32770" "${TITLE} "
  ${EndIf}
!macroend

; LUCANIA: retire le « \ » final éventuel d'un chemin (VAR ne doit pas être $LucaniaTmp)
!macro LUCANIA_STRIP_TRAILING_SLASH VAR
  StrCpy $LucaniaTmp ${VAR} "" -1
  ${If} $LucaniaTmp == "\"
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
!macroend

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"
; LUCANIA: titre de la fenêtre de l'exe de mise à jour (« Mise à jour de Lucania »)
!ifdef LUCANIA_UPDATER
  Caption "$(lucaniaUpdateTitle)"
!endif

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
; LUCANIA: SETUP : pages d'origine (Bienvenue, Licence, Dossier, Menu démarrer, Installation, Fin), toutes
; LUCANIA: sur SkipIfPassive comme dans le template officiel : le setup ne tourne plus jamais sur une
; LUCANIA: installation existante (refus dans .onInit).
; LUCANIA: UPDATE (/DLUCANIA_UPDATER) : seulement Installation puis Fin. Le dossier est imposé (celui de
; LUCANIA: l'installation existante, fixé dans .onInit) et ne peut pas être changé.
!ifndef LUCANIA_UPDATER
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
; LUCANIA: page supprimée : le setup refuse une installation existante dans .onInit,
; LUCANIA: et l'update n'a aucune page de choix.

; 5. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!endif ; LUCANIA: fin des pages réservées au setup

; 6. Start menu shortcut page
; LUCANIA: dans l'update, page déclarée mais toujours sautée (Skip) : les macros MUI_STARTMENU_*
; LUCANIA: de la section Install et du désinstallateur en ont besoin (dossier par défaut).
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !ifdef LUCANIA_UPDATER
    !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
  !else
    !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !endif
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
; LUCANIA: en-têtes adaptés dans l'update (pendant puis après la copie des fichiers)
!ifdef LUCANIA_UPDATER
  !define MUI_PAGE_HEADER_TEXT "$(lucaniaUpdateTitle)"
  !define MUI_PAGE_HEADER_SUBTEXT "$(lucaniaUpdateSubtitle)"
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "$(lucaniaUpdateDoneTitle)"
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "$(lucaniaUpdateDoneSubtitle)"
!endif
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; LUCANIA: case « raccourci Bureau » seulement dans le setup. L'update n'en a pas (elle n'est pas créée
; LUCANIA: du tout, plutôt que masquée) : un raccourci Bureau existant est mis à jour par la section
; LUCANIA: Install (LucaniaUpdateDesktopShortcut), et aucun n'est créé s'il n'existait pas.
!ifndef LUCANIA_UPDATER
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
; LUCANIA: fonction intermédiaire (au lieu de CreateOrUpdateDesktopShortcut) : ne fait rien si
; LUCANIA: RunMainBinary a déjà créé le raccourci (voir $LucaniaDesktopDone ci-dessous)
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION LucaniaFinishDesktopShortcut
; LUCANIA: 1 si le raccourci Bureau a déjà été créé par RunMainBinary sur la page de fin
Var LucaniaDesktopDone
!else
  !define MUI_FINISHPAGE_TITLE "$(lucaniaUpdateDoneTitle)"
  !define MUI_FINISHPAGE_TEXT "$(lucaniaUpdateDoneText)"
!endif
; Show run app after installation.
; LUCANIA: case décochée par défaut dans les deux exe (MUI_FINISHPAGE_RUN_NOTCHECKED, hooks.nsh)
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

; LUCANIA: ordre garanti « raccourci PUIS lancement ». Dans la fonction de sortie de la page de fin
; LUCANIA: (Modern UI 2\Pages\Finish.nsh), MUI appelle MUI_FINISHPAGE_RUN_FUNCTION AVANT
; LUCANIA: MUI_FINISHPAGE_SHOWREADME_FUNCTION : l'app était lancée avant la création du raccourci et
; LUCANIA: plantait. Setup : si la case « raccourci Bureau » est cochée, RunMainBinary crée d'abord le
; LUCANIA: raccourci, met $LucaniaDesktopDone à 1 (LucaniaFinishDesktopShortcut, appelée ensuite par MUI,
; LUCANIA: ne refait rien), attend 300 ms, puis lance l'app. La fenêtre de la page existe encore ici
; LUCANIA: (MUI lit lui-même l'état des cases à ce moment). Update : pas de case raccourci, lancement direct.
Function RunMainBinary
  !ifndef LUCANIA_UPDATER
    ${If} $mui.FinishPage.ShowReadme <> 0
      SendMessage $mui.FinishPage.ShowReadme ${BM_GETCHECK} 0 0 $LucaniaTmp
      ${If} $LucaniaTmp = ${BST_CHECKED}
        Call CreateOrUpdateDesktopShortcut
        StrCpy $LucaniaDesktopDone 1
        Sleep 300
      ${EndIf}
    ${EndIf}
  !endif
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

!ifndef LUCANIA_UPDATER
; LUCANIA: action de la case « raccourci Bureau » (appelée par MUI après RunMainBinary) : crée le
; LUCANIA: raccourci, sauf s'il vient déjà d'être créé par RunMainBinary
Function LucaniaFinishDesktopShortcut
  ${If} $LucaniaDesktopDone = 1
    Return
  ${EndIf}
  Call CreateOrUpdateDesktopShortcut
  StrCpy $LucaniaDesktopDone 1
FunctionEnd
!endif

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

; LUCANIA: textes Lucania (bundle.windows.nsis.languages = French, English ; langue choisie
; LUCANIA: automatiquement selon celle de Windows). $LucaniaInstalledVersion est remplacé à l'exécution
; LUCANIA: par la version installée. Chaque texte n'est compilé que dans l'exe qui l'utilise.
!ifdef LANG_FRENCH
; LUCANIA: double lancement (setup et update se détectent mutuellement, voir .onInit)
LangString lucaniaSetupAlreadyRunning ${LANG_FRENCH} "Une installation ou une mise à jour de ${PRODUCTNAME} est déjà en cours."
; LUCANIA: remplace les textes NSIS intégrés ^FileError (Abandonner/Recommencer/Ignorer) et
; LUCANIA: ^FileError_NoIgnore (Recommencer/Annuler) affichés quand un fichier ne peut pas être écrit
; LUCANIA: (antivirus qui bloque l'exe non signé). Un LangString défini dans le script a priorité sur le
; LUCANIA: texte du fichier .nlf (vérifié avec makensis 3.11 : le texte d'origine disparaît de l'exe).
; LUCANIA: Au moment du message, NSIS place le chemin complet du fichier dans $0 (même jeton que
; LUCANIA: French.nlf / English.nlf). Communs au setup et à l'update.
LangString ^FileError ${LANG_FRENCH} "Impossible d'écrire le fichier :$\r$\n$\r$\n$0$\r$\n$\r$\nVotre antivirus bloque probablement l'installation de ${PRODUCTNAME} (le programme n'est pas encore signé). Ajoutez une exception pour ce programme d'installation et pour le dossier $INSTDIR, puis cliquez sur Recommencer.$\r$\n$\r$\nAbandonner annule l'installation. Ignorer passe ce fichier : ${PRODUCTNAME} serait alors incomplet."
LangString ^FileError_NoIgnore ${LANG_FRENCH} "Impossible d'écrire le fichier :$\r$\n$\r$\n$0$\r$\n$\r$\nVotre antivirus bloque probablement l'installation de ${PRODUCTNAME} (le programme n'est pas encore signé). Ajoutez une exception pour ce programme d'installation et pour le dossier $INSTDIR, puis cliquez sur Recommencer.$\r$\n$\r$\nAnnuler arrête l'installation."
!ifndef LUCANIA_UPDATER
; LUCANIA: setup lancé alors que Lucania est déjà installé
LangString lucaniaAlreadyInstalledUseUpdate ${LANG_FRENCH} "${PRODUCTNAME} est déjà installé sur cet ordinateur.$\r$\n$\r$\nPour le mettre à jour, utilisez le fichier Lucania-Update.exe (disponible sur la page des versions, à côté de ce programme d'installation)."
; LUCANIA: setup : ancienne installation « pour tous les utilisateurs » (Program Files) trouvée ; information
; LUCANIA: seulement, l'installation continue. $LucaniaLegacyDir = dossier trouvé. On ne conseille PAS la
; LUCANIA: désinstallation par Paramètres > Applications : les anciens désinstallateurs (perMachine)
; LUCANIA: suppriment %APPDATA%\${BUNDLEID}, donc les conversations, partagées avec la nouvelle installation.
LangString lucaniaLegacyMachineInstall ${LANG_FRENCH} "Une ancienne installation de ${PRODUCTNAME} pour tous les utilisateurs a été trouvée dans :$\r$\n$\r$\n$LucaniaLegacyDir$\r$\n$\r$\nElle n'est plus utilisée : ${PRODUCTNAME} va maintenant être installé pour votre compte uniquement. Vos conversations et vos réglages sont conservés.$\r$\n$\r$\nPour retirer l'ancienne version, supprimez ce dossier (Windows demandera une autorisation administrateur). Ne la désinstallez pas depuis Paramètres > Applications : son ancien programme de désinstallation effacerait aussi vos conversations."
!else
; LUCANIA: update : refus (pas installé, version plus récente), titres des pages
LangString lucaniaNotInstalledUseSetup ${LANG_FRENCH} "${PRODUCTNAME} n'est pas installé sur cet ordinateur.$\r$\n$\r$\nUtilisez d'abord le programme d'installation Lucania-Setup.exe (disponible sur la page des versions).$\r$\n$\r$\nSi une ancienne version est installée pour tous les utilisateurs (dans Program Files), lancez une fois Lucania-Setup.exe : il installe ${PRODUCTNAME} à son nouvel emplacement, pour votre compte, en conservant vos conversations."
LangString lucaniaNewerInstalled ${LANG_FRENCH} "Une version plus récente de ${PRODUCTNAME} ($LucaniaInstalledVersion) est déjà installée.$\r$\n$\r$\nCette mise à jour (version ${VERSION}) n'est pas nécessaire."
LangString lucaniaUpdateTitle ${LANG_FRENCH} "Mise à jour de ${PRODUCTNAME}"
LangString lucaniaUpdateSubtitle ${LANG_FRENCH} "Installation de la version ${VERSION}. Vos conversations et vos réglages sont conservés."
LangString lucaniaUpdateDoneTitle ${LANG_FRENCH} "Mise à jour terminée"
LangString lucaniaUpdateDoneSubtitle ${LANG_FRENCH} "${PRODUCTNAME} est à jour (version ${VERSION})."
LangString lucaniaUpdateDoneText ${LANG_FRENCH} "${PRODUCTNAME} a été mis à jour vers la version ${VERSION}. Vos conversations et vos réglages ont été conservés.$\r$\n$\r$\nCliquez sur Fermer pour quitter."
!endif
!endif

!ifdef LANG_ENGLISH
; LUCANIA: double lancement (setup et update se détectent mutuellement, voir .onInit)
LangString lucaniaSetupAlreadyRunning ${LANG_ENGLISH} "An installation or update of ${PRODUCTNAME} is already running."
; LUCANIA: message d'écriture impossible (voir le bloc français ci-dessus)
LangString ^FileError ${LANG_ENGLISH} "Unable to write the file:$\r$\n$\r$\n$0$\r$\n$\r$\nYour antivirus is probably blocking the installation of ${PRODUCTNAME} (the program is not signed yet). Add an exception for this installer and for the folder $INSTDIR, then click Retry.$\r$\n$\r$\nAbort cancels the installation. Ignore skips this file: ${PRODUCTNAME} would then be incomplete."
LangString ^FileError_NoIgnore ${LANG_ENGLISH} "Unable to write the file:$\r$\n$\r$\n$0$\r$\n$\r$\nYour antivirus is probably blocking the installation of ${PRODUCTNAME} (the program is not signed yet). Add an exception for this installer and for the folder $INSTDIR, then click Retry.$\r$\n$\r$\nCancel stops the installation."
!ifndef LUCANIA_UPDATER
; LUCANIA: setup lancé alors que Lucania est déjà installé
LangString lucaniaAlreadyInstalledUseUpdate ${LANG_ENGLISH} "${PRODUCTNAME} is already installed on this computer.$\r$\n$\r$\nTo update it, use the file Lucania-Update.exe (available on the releases page, next to this installer)."
; LUCANIA: setup : ancienne installation pour tous les utilisateurs (voir le bloc français ci-dessus)
LangString lucaniaLegacyMachineInstall ${LANG_ENGLISH} "An old installation of ${PRODUCTNAME} for all users was found in:$\r$\n$\r$\n$LucaniaLegacyDir$\r$\n$\r$\nIt is no longer used: ${PRODUCTNAME} will now be installed for your account only. Your conversations and settings are kept.$\r$\n$\r$\nTo remove the old version, delete this folder (Windows will ask for administrator permission). Do not uninstall it from Settings > Apps: its old uninstaller would also erase your conversations."
!else
; LUCANIA: update : refus (pas installé, version plus récente), titres des pages
LangString lucaniaNotInstalledUseSetup ${LANG_ENGLISH} "${PRODUCTNAME} is not installed on this computer.$\r$\n$\r$\nPlease use the installer Lucania-Setup.exe first (available on the releases page).$\r$\n$\r$\nIf an old version is installed for all users (in Program Files), run Lucania-Setup.exe once: it installs ${PRODUCTNAME} in its new location, for your account, and keeps your conversations."
LangString lucaniaNewerInstalled ${LANG_ENGLISH} "A newer version of ${PRODUCTNAME} ($LucaniaInstalledVersion) is already installed.$\r$\n$\r$\nThis update (version ${VERSION}) is not needed."
LangString lucaniaUpdateTitle ${LANG_ENGLISH} "${PRODUCTNAME} Update"
LangString lucaniaUpdateSubtitle ${LANG_ENGLISH} "Installing version ${VERSION}. Your conversations and settings are kept."
LangString lucaniaUpdateDoneTitle ${LANG_ENGLISH} "Update complete"
LangString lucaniaUpdateDoneSubtitle ${LANG_ENGLISH} "${PRODUCTNAME} is up to date (version ${VERSION})."
LangString lucaniaUpdateDoneText ${LANG_ENGLISH} "${PRODUCTNAME} has been updated to version ${VERSION}. Your conversations and settings have been kept.$\r$\n$\r$\nClick Close to exit."
!endif
!endif

Function .onInit
  ; LUCANIA: un seul setup OU update à la fois, détection « au mieux » SANS appel système : l'ancien
  ; LUCANIA: mutex nommé « Global\... » (créé par un appel système via le plugin System) a été retiré, car Norton le
  ; LUCANIA: classait comme comportement suspect (IDP.Generic) dans un exe élevé non signé.
  ; LUCANIA: Instruction NSIS native FindWindow (pas de plugin) : la fenêtre principale d'un installateur
  ; LUCANIA: NSIS est une boîte de dialogue de premier niveau de classe « #32770 », dont le titre est la
  ; LUCANIA: Caption de l'exe, suivie d'une espace sur les pages MUI2 (Caption " " de page) et sans
  ; LUCANIA: espace sur la page Bienvenue. Titres testés (titre exact, avec et sans espace finale) :
  ; LUCANIA:   setup  : « Installation de Lucania » (French.nlf ^SetupCaption), « Lucania Setup » (English.nlf)
  ; LUCANIA:   update : « Mise à jour de Lucania », « Lucania Update » (LangString lucaniaUpdateTitle)
  ; LUCANIA: Le setup et l'update se détectent donc mutuellement, quelle que soit la langue. Le
  ; LUCANIA: désinstallateur (« Désinstallation de Lucania » / « Lucania Uninstall ») n'est PAS bloquant.
  ; LUCANIA: Pendant .onInit, la fenêtre de l'instance courante n'est pas encore créée : FindWindow ne peut
  ; LUCANIA: pas la trouver elle-même. Limites acceptées : une instance silencieuse (/S, sans fenêtre)
  ; LUCANIA: n'est pas détectée, et une MessageBox d'une autre instance (même titre) l'est.
  ; LUCANIA: Si les titres changent (Caption, lucaniaUpdateTitle), mettre à jour la liste ci-dessous.
  StrCpy $LucaniaTmp 0
  !insertmacro LUCANIA_FIND_INSTALLER_WINDOW "Installation de ${PRODUCTNAME}"
  !insertmacro LUCANIA_FIND_INSTALLER_WINDOW "${PRODUCTNAME} Setup"
  !insertmacro LUCANIA_FIND_INSTALLER_WINDOW "Mise à jour de ${PRODUCTNAME}"
  !insertmacro LUCANIA_FIND_INSTALLER_WINDOW "${PRODUCTNAME} Update"
  ${If} $LucaniaTmp <> 0
    MessageBox MB_ICONINFORMATION|MB_OK "$(lucaniaSetupAlreadyRunning)" /SD IDOK
    Abort
  ${EndIf}

  StrCpy $WixMode 0 ; LUCANIA: migration WiX supprimée (évite aussi l'avertissement 6001 de makensis)

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
      ; LUCANIA: %LOCALAPPDATA%\Programs\${PRODUCTNAME} (emplacement standard des applications installées
      ; LUCANIA: pour l'utilisateur, comme VS Code ou Discord) au lieu de $LOCALAPPDATA\${PRODUCTNAME}.
      ; LUCANIA: Distinct du dossier de données $LOCALAPPDATA\${BUNDLEID} (cache WebView2).
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; LUCANIA: détection d'une installation existante, puis aiguillage setup / update.
  ; LUCANIA: Les Abort sont faits ici, directement dans .onInit (l'installateur quitte sans page).
  ; LUCANIA: installMode currentUser : SetContext ci-dessus a fait SetShellVarContext current, donc
  ; LUCANIA: LucaniaDetectInstall (SHCTX) ne voit QUE l'installation de l'utilisateur courant (HKCU).
  ; LUCANIA: Une ancienne installation perMachine (HKLM) n'est pas « déjà installé » : le setup la
  ; LUCANIA: signale (LucaniaDetectLegacyMachineInstall) et l'update l'ignore.
  Call LucaniaDetectInstall
  !ifdef LUCANIA_UPDATER
    ; LUCANIA: UPDATE : Lucania doit être installé
    ${If} $LucaniaInstalled <> 1
      MessageBox MB_ICONINFORMATION|MB_OK "$(lucaniaNotInstalledUseSetup)" /SD IDOK
      Abort
    ${EndIf}
    ; LUCANIA: refus si la version installée est plus récente (SemverCompare : -1 = ${VERSION} plus
    ; LUCANIA: ancienne). Même version : autorisé (répare). Version inconnue (DisplayVersion absent,
    ; LUCANIA: installation abîmée) : autorisé (répare).
    ${If} $LucaniaInstalledVersion != ""
      nsis_tauri_utils::SemverCompare "${VERSION}" $LucaniaInstalledVersion
      Pop $LucaniaTmp
      ${If} $LucaniaTmp = -1
        MessageBox MB_ICONINFORMATION|MB_OK "$(lucaniaNewerInstalled)" /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
    ; LUCANIA: dossier imposé = dossier existant (ignore /D= ; pas de page Dossier). S'il est inconnu
    ; LUCANIA: (registre très abîmé), on garde le dossier par défaut calculé ci-dessus.
    ${If} $LucaniaInstalledDir != ""
      StrCpy $INSTDIR $LucaniaInstalledDir
    ${EndIf}
  !else
    ; LUCANIA: SETUP : première installation uniquement
    ${If} $LucaniaInstalled = 1
      MessageBox MB_ICONINFORMATION|MB_OK "$(lucaniaAlreadyInstalledUseUpdate)" /SD IDOK
      Abort
    ${EndIf}
    ; LUCANIA: ancienne installation pour tous les utilisateurs (Program Files) : information seulement,
    ; LUCANIA: l'installation continue (pas d'Abort) et rien n'est supprimé. Placé après SetContext :
    ; LUCANIA: SetRegView 64 est nécessaire pour lire la clé HKLM écrite par l'ancien installateur x64.
    Call LucaniaDetectLegacyMachineInstall
    ${If} $LucaniaLegacyDir != ""
      MessageBox MB_ICONINFORMATION "$(lucaniaLegacyMachineInstall)" /SD IDOK
    ${EndIf}
  !endif
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
  ; LUCANIA: section commune au setup et à l'update : copie par-dessus, réécrit uninstall.exe et les
  ; LUCANIA: clés du registre (répare une installation abîmée), ne désinstalle rien.
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ; LUCANIA: serveur embarqué node.exe : normalement arrêté avec l'app (RunEvent::Exit), mais il peut
  ; LUCANIA: survivre si l'app a été tuée de force ; il verrouillerait node.exe et app\. Vérifié par son
  ; LUCANIA: CHEMIN COMPLET (Restart Manager) : les autres node.exe de la machine ne sont pas touchés.
  ${If} ${FileExists} "$INSTDIR\node.exe"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\node.exe" "${PRODUCTNAME}"
  ${EndIf}

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

  !ifdef LUCANIA_UPDATER
    ; LUCANIA: update : raccourci Bureau mis à jour s'il existe (et pointe vers Lucania), jamais créé,
    ; LUCANIA: quel que soit le mode (pas de case sur la page de fin)
    Call LucaniaUpdateDesktopShortcut
  !else
  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
  !endif

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
  !insertmacro LUCANIA_UNQUOTE $4 ; LUCANIA: chemin du registre éventuellement entre guillemets
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
; LUCANIA: fonctions ajoutées (détection d'une installation existante, raccourci Bureau de l'update)
; ---------------------------------------------------------------------------------------------

; LUCANIA: détection (dans .onInit, après SetContext) d'une installation existante. Sorties :
; LUCANIA:   $LucaniaInstalled        = 1 si ${UNINSTKEY} a un UninstallString ou un DisplayVersion, OU si
; LUCANIA:                              le dossier enregistré existe et contient un fichier de Lucania
; LUCANIA:                              (${MAINBINARYNAME}.exe, uninstall.exe, node.exe ou app\) ; sinon 0.
; LUCANIA:                              Un dossier enregistré mais vide ou absent (reste d'une ancienne
; LUCANIA:                              désinstallation, qui ne supprime pas toujours ${MANUPRODUCTKEY})
; LUCANIA:                              ne compte pas : le setup reste alors utilisable.
; LUCANIA:   $LucaniaInstalledVersion = DisplayVersion (vide si inconnue) ;
; LUCANIA:   $LucaniaInstalledDir     = valeur par défaut de ${MANUPRODUCTKEY} (comme
; LUCANIA:                              RestorePreviousInstallLocation), sinon InstallLocation de
; LUCANIA:                              ${UNINSTKEY}, sinon dossier de UninstallString ; sans guillemets
; LUCANIA:                              (LUCANIA_UNQUOTE) ni « \ » final.
; LUCANIA: Registres préservés ($0, $1).
; LUCANIA: Lit SHCTX, c'est-à-dire HKCU en installMode currentUser (installation de l'utilisateur courant).
Function LucaniaDetectInstall
  Push $0
  Push $1
  StrCpy $LucaniaInstalled 0

  ReadRegStr $LucaniaInstalledVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $0 != ""
  ${OrIf} $LucaniaInstalledVersion != ""
    StrCpy $LucaniaInstalled 1
  ${EndIf}

  ReadRegStr $1 SHCTX "${MANUPRODUCTKEY}" ""
  !insertmacro LUCANIA_UNQUOTE $1
  ${If} $1 == ""
    ReadRegStr $1 SHCTX "${UNINSTKEY}" "InstallLocation"
    !insertmacro LUCANIA_UNQUOTE $1
  ${EndIf}
  ${If} $1 == ""
  ${AndIf} $0 != ""
    ; UninstallString est écrit "C:\...\uninstall.exe" (avec guillemets)
    !insertmacro LUCANIA_UNQUOTE $0
    ${GetParent} $0 $1
  ${EndIf}
  !insertmacro LUCANIA_STRIP_TRAILING_SLASH $1
  StrCpy $LucaniaInstalledDir $1

  ${If} $1 != ""
    ${If} ${FileExists} "$1\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "$1\uninstall.exe"
    ${OrIf} ${FileExists} "$1\node.exe"
    ${OrIf} ${FileExists} "$1\app\*.*"
      StrCpy $LucaniaInstalled 1
    ${EndIf}
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd

!ifndef LUCANIA_UPDATER
; LUCANIA: setup seulement (dans .onInit, après SetContext) : cherche une ancienne installation
; LUCANIA: perMachine (versions <= 0.1.11, Program Files + HKLM). Lit HKLM EXPLICITEMENT (et non SHCTX,
; LUCANIA: qui vaut HKCU en currentUser), en vue 64 bits (SetRegView 64 de SetContext). Ne modifie rien.
; LUCANIA: Sortie : $LucaniaLegacyDir = dossier de l'ancienne installation, vide si aucune. Trouvée si :
; LUCANIA:   - le dossier enregistré en HKLM (${MANUPRODUCTKEY}, sinon InstallLocation, sinon dossier de
; LUCANIA:     UninstallString de ${UNINSTKEY}) contient un fichier de Lucania (${MAINBINARYNAME}.exe,
; LUCANIA:     uninstall.exe, node.exe ou app\) ;
; LUCANIA:   - sinon $PROGRAMFILES64\${PRODUCTNAME} contient un de ces fichiers ;
; LUCANIA:   - sinon HKLM\${UNINSTKEY} a un UninstallString ou un DisplayVersion (entrée encore visible dans
; LUCANIA:     Paramètres > Applications) : dossier enregistré, ou $PROGRAMFILES64\${PRODUCTNAME} par défaut.
; LUCANIA: Une valeur HKLM\${MANUPRODUCTKEY} seule, dont le dossier est vide ou absent (reste d'une ancienne
; LUCANIA: désinstallation, qui ne la supprime que si la case « données » est cochée), ne compte pas.
; LUCANIA: Registres préservés ($0, $1, $2).
Function LucaniaDetectLegacyMachineInstall
  Push $0
  Push $1
  Push $2
  StrCpy $LucaniaLegacyDir ""

  ReadRegStr $0 HKLM "${UNINSTKEY}" "UninstallString"
  ReadRegStr $1 HKLM "${UNINSTKEY}" "DisplayVersion"
  StrCpy $2 0
  ${If} $0 != ""
  ${OrIf} $1 != ""
    StrCpy $2 1
  ${EndIf}

  ReadRegStr $1 HKLM "${MANUPRODUCTKEY}" ""
  !insertmacro LUCANIA_UNQUOTE $1
  ${If} $1 == ""
    ReadRegStr $1 HKLM "${UNINSTKEY}" "InstallLocation"
    !insertmacro LUCANIA_UNQUOTE $1
  ${EndIf}
  ${If} $1 == ""
  ${AndIf} $0 != ""
    !insertmacro LUCANIA_UNQUOTE $0
    ${GetParent} $0 $1
  ${EndIf}
  !insertmacro LUCANIA_STRIP_TRAILING_SLASH $1

  ${If} $1 != ""
    ${If} ${FileExists} "$1\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "$1\uninstall.exe"
    ${OrIf} ${FileExists} "$1\node.exe"
    ${OrIf} ${FileExists} "$1\app\*.*"
      StrCpy $LucaniaLegacyDir $1
    ${EndIf}
  ${EndIf}

  ${If} $LucaniaLegacyDir == ""
    ${If} ${FileExists} "$PROGRAMFILES64\${PRODUCTNAME}\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "$PROGRAMFILES64\${PRODUCTNAME}\uninstall.exe"
    ${OrIf} ${FileExists} "$PROGRAMFILES64\${PRODUCTNAME}\node.exe"
    ${OrIf} ${FileExists} "$PROGRAMFILES64\${PRODUCTNAME}\app\*.*"
      StrCpy $LucaniaLegacyDir "$PROGRAMFILES64\${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}

  ${If} $LucaniaLegacyDir == ""
  ${AndIf} $2 = 1
    ${If} $1 != ""
      StrCpy $LucaniaLegacyDir $1
    ${Else}
      StrCpy $LucaniaLegacyDir "$PROGRAMFILES64\${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!ifdef LUCANIA_UPDATER
; LUCANIA: update : met à jour le raccourci Bureau (nouvelle cible, icône, AppUserModelId) seulement
; LUCANIA: s'il existe et pointe vers ${MAINBINARYNAME}.exe (ou vers l'ancien nom d'exe) de $INSTDIR.
; LUCANIA: N'en crée jamais. CreateOrUpdateDesktopShortcut (template) migre l'ancien nom d'exe, sinon
; LUCANIA: réécrit le raccourci (sauf /UPDATE ou /NS). $0-$3 modifiés (IsShortcutTarget), comme le template.
Function LucaniaUpdateDesktopShortcut
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 <> 1
  ${AndIf} $OldMainBinaryName != ""
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
    Pop $0
  ${EndIf}
  ${If} $0 = 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
FunctionEnd
!endif
