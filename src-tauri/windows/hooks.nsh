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
; Qui passe /UPDATE ? Le template par défaut de Tauri NE le passe PAS quand on choisit
; « Désinstaller avant d'installer » (seulement si l'installateur a lui-même été lancé avec /UPDATE) :
; c'est ce qui effaçait les conversations lors d'une mise à jour. Notre template
; (windows/installer.nsi, « Mettre à jour proprement ») lance TOUJOURS l'ancien désinstallateur
; avec « /UPDATE /P » : les données sont conservées, y compris avec l'ancien désinstallateur 0.0.1.
; « Mettre à jour » (choix par défaut) ne lance aucun désinstallateur.
;
; Ne pas renommer /UPDATE : c'est le seul drapeau que les désinstallateurs déjà installés connaissent.
;
; Contexte : installMode perMachine => l'installateur est en « SetShellVarContext all », où
; $APPDATA/$LOCALAPPDATA pointent vers ProgramData. On repasse donc en contexte « current »
; (utilisateur courant) pour la suppression, puis on restaure le contexte « all ».

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\${BUNDLEID}"
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    SetShellVarContext all
  ${EndIf}
!macroend

; Page de fin : la case « Lancer Lucania » est décochée par défaut. Le template l'exécute via
; nsis_tauri_utils::RunAsUser sur l'exe tout juste installé ; l'antivirus (Norton) l'analyse à
; cet instant et l'appel bloque, ce qui fige l'installateur sur « Terminer ». L'utilisateur
; lance l'application via le raccourci.
!define MUI_FINISHPAGE_RUN_NOTCHECKED

; Case « Créer un raccourci sur le Bureau » décochée par défaut (évite un blocage sur
; « Terminer » pendant la création du raccourci/analyse antivirus) ; l'utilisateur peut la cocher.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
