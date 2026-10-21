using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
static class Updater {
  public static Form CreateWindow() {
    Form form=new Form { Text="小紅書直播錄影機 · 自動更新",ClientSize=new System.Drawing.Size(540,210),StartPosition=FormStartPosition.CenterScreen,Font=new System.Drawing.Font("Microsoft JhengHei",10),FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false };
    Label description=new Label { Text="確認新版後，自動下載、驗證並安裝到原本位置。\r\n不需要選擇 EXE 檔或資料夾。\r\n\r\n啟用自動重載後，安裝完成會自動切換新版。\r\n更新前請先解除直播待命並儲存影片。",Dock=DockStyle.Top,Height=140,Padding=new Padding(16) };
    Button update=new Button { Text="檢查更新並安裝",Dock=DockStyle.Bottom,Height=45 };
    form.Controls.Add(description);form.Controls.Add(update);
    update.Click += async delegate { await Run(form,update); };
    form.Shown += async delegate { await Run(form,update); };
    return form;
  }
  public static string InstallArguments(string installDir) {
    return "/SP- /SILENT /NORESTART /DIR=\"" + Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar) + "\"";
  }
  public static string ValidateFeed(Dictionary<string,object> data, Version current) {
    Version version;
    if (!data.ContainsKey("version") || !Version.TryParse(data["version"] as string,out version)) throw new InvalidDataException("更新版本格式不正確。");
    if (version <= current) return null;
    string expected="https://github.com/wuwu50/ednote-live-recorder-/releases/download/v" + data["version"] + "/RednoteLiveRecorder-" + data["version"] + "-Setup.exe";
    if (!data.ContainsKey("downloadUrl") || (data["downloadUrl"] as string) != expected) throw new InvalidDataException("不是本程式的官方安裝包網址。");
    string hash=data.ContainsKey("sha256") ? data["sha256"] as string : null;
    if (hash==null || !System.Text.RegularExpressions.Regex.IsMatch(hash,"^[a-fA-F0-9]{64}$")) throw new InvalidDataException("新版尚未提供有效的檔案驗證資訊，暫不安裝。");
    return expected;
  }
  public static async Task Run(Form owner,Button button) {
    button.Enabled=false; string original=button.Text; string tempFile=null;
    try {
      ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
      button.Text="正在檢查…";
      Dictionary<string,object> feed;
      using (WebClient client=new WebClient()) {
        client.Headers[HttpRequestHeader.UserAgent]="RednoteLiveRecorder-Updater";
        string json=await client.DownloadStringTaskAsync("https://raw.githubusercontent.com/wuwu50/ednote-live-recorder-/main/version.json?t="+DateTime.UtcNow.Ticks);
        feed=new JavaScriptSerializer { MaxJsonLength=65536 }.Deserialize<Dictionary<string,object>>(json);
      }
      string url=ValidateFeed(feed,System.Reflection.Assembly.GetExecutingAssembly().GetName().Version);
      if (url==null) { MessageBox.Show(owner,"目前已是最新版本。","程式更新"); return; }
      string text="發現新版 v" + feed["version"] + "。\r\n\r\n請確認所有錄影已停止並完成儲存。\r\n確認後會自動下載、驗證並安裝到原本位置，不需要選擇檔案或資料夾。\r\n啟用自動重載後，安裝完成將自動切換新版；錄影或儲存中會延後。\r\n\r\n現在安裝嗎？";
      if (MessageBox.Show(owner,text,"確認更新",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes) return;
      string cacheDir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"RednoteLiveRecorder","Updates");
      Directory.CreateDirectory(cacheDir);
      tempFile=Path.Combine(cacheDir,"Setup-"+Guid.NewGuid().ToString("N")+".exe");
      using (WebClient client=new WebClient()) {
        client.DownloadProgressChanged += delegate(object sender,DownloadProgressChangedEventArgs e) { button.Text="下載中 " + e.ProgressPercentage + "%"; };
        await client.DownloadFileTaskAsync(url,tempFile);
      }
      button.Text="驗證檔案…";
      string actual;
      using (SHA256 sha=SHA256.Create()) using(FileStream file=File.OpenRead(tempFile)) actual=BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();
      if (!String.Equals(actual,feed["sha256"] as string,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("檔案驗證失敗，未執行安裝。請重新檢查更新。");
      string log=Path.Combine(cacheDir,"install-"+DateTime.UtcNow.ToString("yyyyMMddHHmmss")+".log");
      Process.Start(new ProcessStartInfo(tempFile,InstallArguments(AppDomain.CurrentDomain.BaseDirectory)+" /LOG=\""+log+"\"") { UseShellExecute=true });
      tempFile=null; // Installer is running from this path; keep until a future cleanup.
      owner.Close();
    } catch(Exception error) { MessageBox.Show(owner,error.Message,"更新未完成",MessageBoxButtons.OK,MessageBoxIcon.Warning); }
    finally {
      if(tempFile!=null) { try { File.Delete(tempFile); } catch { } }
      if(!owner.IsDisposed) { button.Text=original; button.Enabled=true; }
    }
  }
  public static int SelfTest() {
    var feed=new Dictionary<string,object> { {"version","9.0.0"},{"downloadUrl","https://github.com/wuwu50/ednote-live-recorder-/releases/download/v9.0.0/RednoteLiveRecorder-9.0.0-Setup.exe"},{"sha256",new string('a',64)} };
    if(ValidateFeed(feed,new Version("1.0.0"))==null) return 1;
    if(ValidateFeed(feed,new Version("10.0.0"))!=null) return 2;
    feed["downloadUrl"]="https://example.com/malware.exe";
    try { ValidateFeed(feed,new Version("1.0.0")); return 3; } catch(InvalidDataException) { }
    if(!InstallArguments(@"C:\Test Folder\Recorder").Contains("/DIR=\"C:\\Test Folder\\Recorder\"")) return 4;
    return 0;
  }
}
