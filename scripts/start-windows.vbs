' Lanceur Lucania pour Windows.
' Place-toi dans le dossier du projet (parent du dossier "scripts"),
' lance le serveur de développement en arrière-plan puis ouvre le navigateur.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Dossier du script, puis son parent (racine du projet)
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = projectDir

' Lance "npm run dev" dans une fenêtre cachée (0), sans attendre la fin
shell.Run "cmd /c npm run dev", 0, False

' Attend 5 secondes que le serveur démarre
WScript.Sleep 5000

' Ouvre l'application
shell.Run "http://localhost:4748"
