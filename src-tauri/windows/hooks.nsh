; Hooks NSIS de l'installateur Lucania (bundle.windows.nsis.installerHooks).
;
; Données utilisateur :
;   %APPDATA%\com.lucania.desktop       (roaming : base SQLite data\app.db, conversations)
;   %LOCALAPPDATA%\com.lucania.desktop  (cache WebView2, dont le localStorage des préférences)
;
; DESINSTALLATION (Paramètres Windows, désinstallateur lancé SANS /UPDATE) :
;   les deux dossiers ci-dessus sont supprimés, que la case « supprimer les données de
;   l'application » soit cochée ou non (les conversations n'ont aucun intérêt sans l'application).
;
; DESINSTALLATION AVEC /UPDATE ($UpdateMode = 1) : le hook ne fait RIEN, les données sont conservées
;   (la case du template est elle aussi ignorée avec /UPDATE).
;
; Mises à jour : notre template (windows/installer.nsi) ne lance plus AUCUN désinstallateur. Le setup
; (…-setup.exe) refuse de s'exécuter si Lucania est déjà installé ; l'exe de mise à jour
; (…-update.exe, compilé avec /DLUCANIA_UPDATER par scripts/build-updater.mjs) copie les fichiers
; par-dessus l'installation existante. Les données ne sont donc jamais touchées par une mise à jour.
;
; Ne pas renommer /UPDATE : c'est le seul drapeau que les désinstallateurs déjà installés connaissent
; (un ancien installateur ou un outil externe peut encore lancer « uninstall.exe /UPDATE »).
;
; Contexte : installMode currentUser (depuis la 0.1.12, tauri.conf.json) => l'installateur et le
; désinstallateur sont déjà en « SetShellVarContext current » (macro SetContext de utils.nsh) :
; $APPDATA et $LOCALAPPDATA sont ceux de l'utilisateur courant, on ne change donc pas de contexte.
; Le programme est installé dans %LOCALAPPDATA%\Programs\Lucania, dossier DISTINCT des données
; %LOCALAPPDATA%\com.lucania.desktop : seul ce hook (vraie désinstallation) supprime les données.
; Si l'on revenait en perMachine (contexte « all », où $APPDATA/$LOCALAPPDATA pointent vers ProgramData),
; les deux !if repassent en « current » pour la suppression puis restaurent « all » ; en currentUser,
; ils ne produisent aucune instruction.
;
; Attention : les ANCIENS désinstallateurs perMachine (versions <= 0.1.11, dans Program Files) contiennent
; ce même hook : lancés depuis Paramètres > Applications, ils effacent aussi ces données (partagées avec la
; nouvelle installation). Le setup conseille donc de supprimer l'ancien dossier plutôt que de le désinstaller.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    !if "${INSTALLMODE}" == "perMachine"
      SetShellVarContext current
    !endif
    RMDir /r "$APPDATA\${BUNDLEID}"
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    !if "${INSTALLMODE}" == "perMachine"
      SetShellVarContext all
    !endif
  ${EndIf}
!macroend

; Page de fin : la case « Lancer Lucania » est décochée par défaut. Le template l'exécute via
; nsis_tauri_utils::RunAsUser sur l'exe tout juste installé ; l'antivirus (Norton) l'analyse à
; cet instant et l'appel bloque, ce qui fige l'installateur sur « Terminer ». L'utilisateur
; lance l'application via le raccourci.
!define MUI_FINISHPAGE_RUN_NOTCHECKED

; Case « Créer un raccourci sur le Bureau » décochée par défaut (évite un blocage sur
; « Terminer » pendant la création du raccourci/analyse antivirus) ; l'utilisateur peut la cocher.
; Cette case n'existe que dans le setup ; l'exe de mise à jour n'en a pas (sans effet pour lui).
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
