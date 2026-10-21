#ifndef AppVersion
  #define AppVersion "0.5.0"
#endif
[Setup]
AppId={{E7B9A536-4C28-4E0F-A2D9-B07B603AB749}
AppName=小紅書直播錄影機
AppVersion={#AppVersion}
AppPublisher=wuwu50
AppPublisherURL=https://github.com/wuwu50/ednote-live-recorder-
DefaultDirName={localappdata}\Programs\RednoteLiveRecorder
DefaultGroupName=小紅書直播錄影機
PrivilegesRequired=lowest
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=RednoteLiveRecorder-{#AppVersion}-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\RednoteLiveRecorder.exe
CloseApplications=no
InfoBeforeFile=install-info.txt
[Tasks]
Name: desktopicon; Description: "建立桌面捷徑"; GroupDescription: "捷徑："
[Files]
Source: "..\build\RednoteLiveRecorder.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\小紅書直播錄影機"; Filename: "{app}\RednoteLiveRecorder.exe"
Name: "{userdesktop}\小紅書直播錄影機"; Filename: "{app}\RednoteLiveRecorder.exe"; Tasks: desktopicon
[Registry]
Root: HKCU; Subkey: "Software\Classes\rednoteliverecorder"; ValueType: string; ValueData: "URL:RednoteLiveRecorder Update"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\rednoteliverecorder"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\rednoteliverecorder\shell\open\command"; ValueType: string; ValueData: """{app}\RednoteLiveRecorder.exe"" --update"
[Run]
Filename: "{app}\RednoteLiveRecorder.exe"; Description: "開啟小紅書直播錄影機安裝與啟動介面"; Flags: nowait postinstall skipifsilent

[InstallDelete]
Type: files; Name: "{app}\extension\install-complete.json"
Type: files; Name: "{app}\extension\install-complete.json.tmp"

[UninstallDelete]
Type: files; Name: "{app}\extension\install-complete.json"
Type: files; Name: "{app}\extension\install-complete.json.tmp"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  Marker, Temporary: String;
begin
  if CurStep = ssPostInstall then
  begin
    Marker := ExpandConstant('{app}\extension\install-complete.json');
    Temporary := Marker + '.tmp';
    if not SaveStringToFile(Temporary, '{"version":"{#AppVersion}","complete":true}', False) then
      RaiseException('Cannot write installation completion marker.');
    if not RenameFile(Temporary, Marker) then
      RaiseException('Cannot finalize installation completion marker.');
  end;
end;
