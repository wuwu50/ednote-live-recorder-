using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;
[assembly: AssemblyTitle("小紅書直播錄影機")]
[assembly: AssemblyVersion("0.3.0.0")]
static class Launcher {
  static readonly string ExtensionPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"extension");
  [STAThread] static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--updater-self-test") return Updater.SelfTest();
    if (args.Length == 1 && args[0] == "--self-test") return File.Exists(Path.Combine(ExtensionPath,"manifest.json")) ? 0 : 1;
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    if (args.Length > 0 && args[0] == "--update") { Application.Run(Updater.CreateWindow()); return 0; }
    Form form = new Form { Text="小紅書直播錄影機 · 安裝與啟動", ClientSize=new Size(660,560), MinimumSize=new Size(600,550), StartPosition=FormStartPosition.CenterScreen, BackColor=Color.FromArgb(16,23,36), ForeColor=Color.FromArgb(233,238,248), Font=new Font("Microsoft JhengHei",10), AutoScaleMode=AutoScaleMode.Dpi };
    TableLayoutPanel layout = new TableLayoutPanel { Dock=DockStyle.Fill, Padding=new Padding(26), ColumnCount=1, RowCount=7 };
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,60));
    layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,28));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,54));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,54));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,60));
    layout.Controls.Add(new Label { Text="小紅書直播錄影機  v0.3.0", Font=new Font("Microsoft JhengHei",20,FontStyle.Bold), Dock=DockStyle.Fill, TextAlign=ContentAlignment.MiddleLeft },0,0);
    layout.Controls.Add(new Label { Text="第一次使用：\r\n\r\n1. 按下方按鈕開啟 Chrome 擴充功能頁。\r\n2. 開啟右上角「開發人員模式」。\r\n3. 按「載入未封裝項目」，貼上下方資料夾路徑。\r\n4. 釘選「小紅書直播錄影機」到 Chrome 工具列。\r\n\r\n錄影：在主播分頁點圖示，所有操作都在同一控制視窗。\r\n升級：先停止錄影並儲存，安裝後會自動啟用新版。\r\n直播：同一視窗選好資料夾後啟用待命；可最小化，請勿關閉。", Dock=DockStyle.Fill },0,1);
    layout.Controls.Add(new Label { Text="Chrome 要載入的擴充功能資料夾",Dock=DockStyle.Fill },0,2);
    layout.Controls.Add(new TextBox { Text=ExtensionPath, ReadOnly=true, Dock=DockStyle.Fill },0,3);
    FlowLayoutPanel controls = new FlowLayoutPanel {Dock=DockStyle.Fill};
    Button open=Button("開啟 Chrome 擴充功能頁",260),copy=Button("複製資料夾路徑",200);
    open.Click += delegate { Try(delegate { OpenChrome(); }); };
    copy.Click += delegate { Try(delegate { Clipboard.SetText(ExtensionPath); copy.Text="已複製路徑"; }); };
    controls.Controls.Add(open); controls.Controls.Add(copy); layout.Controls.Add(controls,0,4);
    FlowLayoutPanel secondary = new FlowLayoutPanel {Dock=DockStyle.Fill};
    Button folder=Button("開啟安裝資料夾",190),download=Button("檢查更新並安裝",190);
    folder.Click += delegate { Try(delegate { Process.Start("explorer.exe", "\""+ExtensionPath+"\""); }); };
    download.Click += async delegate { await Updater.Run(form,download); };
    secondary.Controls.Add(folder); secondary.Controls.Add(download); layout.Controls.Add(secondary,0,5);
    layout.Controls.Add(new Label { Text="錄影控制在 Chrome 內操作。最小化後網站可能暫停更新，請先短錄測試。\r\n解除安裝前，請先從 Chrome 移除此擴充功能。", Dock=DockStyle.Fill, ForeColor=Color.FromArgb(157,177,205),Font=new Font("Microsoft JhengHei",9) },0,6);
    form.Controls.Add(layout); Application.Run(form); return 0;
  }
  static Button Button(string title,int width) { return new Button { Text=title, Width=width, Height=40, FlatStyle=FlatStyle.Flat, BackColor=Color.FromArgb(34,52,73), ForeColor=Color.FromArgb(208,237,226), Margin=new Padding(0,0,12,0) }; }
  static void Try(Action action) { try { action(); } catch (Exception e) { MessageBox.Show(e.Message,"無法完成操作",MessageBoxButtons.OK,MessageBoxIcon.Warning); } }
  static void OpenChrome() {
    string[] roots = { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) };
    foreach (string root in roots) {
      string exe=Path.Combine(root,"Google","Chrome","Application","chrome.exe");
      if (File.Exists(exe)) { Process.Start(exe,"chrome://extensions/"); return; }
    }
    foreach (RegistryKey registry in new RegistryKey[] {Registry.CurrentUser,Registry.LocalMachine}) {
      using (RegistryKey key=registry.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe")) {
        string exe=key==null ? null : key.GetValue(null) as string;
        if (!String.IsNullOrEmpty(exe) && File.Exists(exe)) { Process.Start(exe,"chrome://extensions/"); return; }
      }
    }
    throw new InvalidOperationException("找不到 Google Chrome。請先安裝 Chrome 116 以上版本，或自行在 Chrome 輸入 chrome://extensions。");
  }
}
