; NudgeApp for Windows - per-user installer (no admin rights). build.py compiles it with:
;   iscc /DAppVersion=1.0.0 /DSourceDir=<dist\NudgeApp> /DOutputDir=<dist> /DIconFile=<build\nudge.ico> nudge.iss
; Installs to %LOCALAPPDATA%\Programs\NudgeApp, adds NudgeApp to the Start menu (and optionally the desktop) and lists it
; in Settings > Apps. The window keeps its data (what you saved in it) in %LOCALAPPDATA%\NudgeApp, which
; uninstalling leaves in place so a reinstall finds it again.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "dist\NudgeApp"
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif
#ifndef IconFile
  #define IconFile "build\nudge.ico"
#endif

[Setup]
AppId={{E81247BA-698B-569E-A6DE-E1E1C366EEFB}
AppName=NudgeApp
AppVersion={#AppVersion}
AppVerName=NudgeApp {#AppVersion}
AppPublisher=Juwen Lie
AppPublisherURL=https://juw12.github.io/nudge/
AppSupportURL=https://github.com/juw12/nudge
DefaultDirName={autopf}\NudgeApp
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=NudgeApp-Windows-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\NudgeApp.exe
UninstallDisplayName=NudgeApp
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\NudgeApp"; Filename: "{app}\NudgeApp.exe"; Comment: "See who is waiting on a reply"
Name: "{userdesktop}\NudgeApp"; Filename: "{app}\NudgeApp.exe"; Comment: "See who is waiting on a reply"; Tasks: desktopicon

[Run]
Filename: "{app}\NudgeApp.exe"; Description: "{cm:LaunchProgram,NudgeApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\NudgeApp.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopNudgeApp"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  { Updating: close an open NudgeApp window first so its files can be replaced. }
  if FileExists(ExpandConstant('{app}\NudgeApp.exe')) then
    Exec(ExpandConstant('{app}\NudgeApp.exe'), '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
