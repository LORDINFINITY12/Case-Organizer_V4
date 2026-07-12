; Case Organizer — Inno Setup 6 script (dual-mode installer).
;
; Compile:  iscc /DAppVersion=<version> installer.iss     (build.ps1 does this)
;
; Two install modes:
;   * Userspace (default, no admin): per-user install, tray app, optional
;     Startup-folder autostart.  Data in %APPDATA%\CaseOrganizer.
;   * Service (choose "all users" -> tick the service task, needs admin):
;     Program Files install, WinSW-wrapped Windows service running the app
;     with --headless.  Data in %ProgramData%\CaseOrganizer.  The shortcuts
;     then merely open the browser (CaseOrganizer.exe --open).
;
; Uninstall never touches the data directories or the user's case files.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{15733027-A1C4-41DA-8646-037FB819190F}
AppName=Case Organizer
AppVersion={#AppVersion}
AppPublisher=LORDINFINITY12
AppPublisherURL=https://github.com/LORDINFINITY12/Case-Organizer_V4
DefaultDirName={autopf}\CaseOrganizer
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=CaseOrganizer-Setup-{#AppVersion}
SetupIconFile=caseorg.ico
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayIcon={app}\CaseOrganizer.exe
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"
Name: "startupicon"; Description: "Start Case Organizer when Windows starts (&tray app)"; Check: not IsAdminInstallMode
Name: "servicemode"; Description: "Install as a Windows &service (runs at boot, before anyone logs in)"; Flags: unchecked; Check: IsAdminInstallMode

[Files]
Source: "..\dist\CaseOrganizer\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs
; WinSW pairs with the XML sharing its basename, next to the service exe.
Source: "CaseOrganizerService.xml"; DestDir: "{app}\_internal\vendor\winsw"; Check: IsServiceMode

[Icons]
Name: "{autoprograms}\Case Organizer"; Filename: "{app}\CaseOrganizer.exe"; Parameters: "{code:ShortcutArgs}"; IconFilename: "{app}\CaseOrganizer.exe"
Name: "{autodesktop}\Case Organizer"; Filename: "{app}\CaseOrganizer.exe"; Parameters: "{code:ShortcutArgs}"; IconFilename: "{app}\CaseOrganizer.exe"; Tasks: desktopicon
Name: "{userstartup}\Case Organizer"; Filename: "{app}\CaseOrganizer.exe"; Tasks: startupicon

[Run]
; Service mode: register + start the WinSW-wrapped service.
Filename: "{app}\_internal\vendor\winsw\CaseOrganizerService.exe"; Parameters: "install"; WorkingDir: "{app}"; Check: IsServiceMode; Flags: runhidden waituntilterminated
Filename: "{app}\_internal\vendor\winsw\CaseOrganizerService.exe"; Parameters: "start"; Check: IsServiceMode; Flags: runhidden waituntilterminated
; Both modes: offer to open the app when setup finishes.
Filename: "{app}\CaseOrganizer.exe"; Parameters: "{code:ShortcutArgs}"; Description: "Launch Case Organizer"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\_internal\vendor\winsw\CaseOrganizerService.exe"; Parameters: "stop"; Check: IsServiceMode; Flags: runhidden waituntilterminated; RunOnceId: "StopSvc"
Filename: "{app}\_internal\vendor\winsw\CaseOrganizerService.exe"; Parameters: "uninstall"; Check: IsServiceMode; Flags: runhidden waituntilterminated; RunOnceId: "UninstSvc"

[UninstallDelete]
; Only build artifacts under {app}; %APPDATA%/%ProgramData% CaseOrganizer
; directories and the chosen case-files folder are deliberately preserved.
Type: filesandordirs; Name: "{app}\_internal\vendor\winsw\*.log"

[Code]
function IsServiceMode: Boolean;
begin
  Result := IsAdminInstallMode and WizardIsTaskSelected('servicemode');
end;

function ShortcutArgs(Param: String): String;
begin
  if IsServiceMode then
    Result := '--open'
  else
    Result := '';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  { Per-user installs land in {localappdata}\Programs instead of Program Files. }
  if (CurPageID = wpSelectDir) and not IsAdminInstallMode then
    WizardForm.DirEdit.Text := ExpandConstant('{localappdata}\Programs\CaseOrganizer');
end;

function InitializeSetup: Boolean;
begin
  Result := True;
end;
