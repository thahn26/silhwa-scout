; 실화탐사대 아이템 레이더 — 윈도우 설치 프로그램 (Inno Setup 6)
; GitHub Actions(.github/workflows/windows-installer.yml)가 build\python 에 설치 없는 파이썬을 받아 둔 뒤 컴파일한다.

#define AppName "실화탐사대 아이템 레이더"
#define AppVersion GetEnv("APP_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{7C1E3A52-5B8B-4F7B-9C2D-3E6A1F0B9D41}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=실화탐사대 제작팀
DefaultDirName={localappdata}\Programs\SilhwaScout
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
; 관리자 암호 없이 사용자 폴더에 설치한다
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=SilhwaScout_Setup_{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 아이콘 만들기"; GroupDescription: "아이콘:"

[Files]
Source: "..\build\python\*"; DestDir: "{app}\python"; Flags: recursesubdirs ignoreversion
Source: "..\server.py"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\sources.py"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\minisoup.py"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\web\*"; DestDir: "{app}\app\web"; Flags: recursesubdirs ignoreversion
Source: "launcher.pyw"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "사용안내.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\launcher.pyw"""; WorkingDir: "{app}\app"; IconFilename: "{app}\icon.ico"
Name: "{autoprograms}\{#AppName} 사용안내"; Filename: "{app}\사용안내.txt"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\launcher.pyw"""; WorkingDir: "{app}\app"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\launcher.pyw"""; WorkingDir: "{app}\app"; Description: "지금 실행"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\launcher.pyw"" --stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopServer"

[Code]
// 업데이트 설치 때 켜져 있는 예전 서버를 먼저 끈다(파일이 잠겨 덮어쓰지 못하는 일을 막는다)
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep = ssInstall) and FileExists(ExpandConstant('{app}\python\pythonw.exe')) then
  begin
    Exec(ExpandConstant('{app}\python\pythonw.exe'), '"' + ExpandConstant('{app}\app\launcher.pyw') + '" --stop',
         ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(1500);
  end;
end;
