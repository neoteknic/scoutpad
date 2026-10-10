using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace ScoutPad {
    internal static class Launcher {
        private const string Url = "http://127.0.0.1:18114/";

        [STAThread]
        private static void Main(string[] args) {
            bool created;
            using (var mutex = new Mutex(true, "Local\\ScoutPad.Desktop", out created)) {
                if (!created) { OpenBrowser(); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string root = AppDomain.CurrentDomain.BaseDirectory;
                var start = new ProcessStartInfo(Path.Combine(root, "scout-backend.exe"), "-assets \"" + Path.Combine(root, "public") + "\"") {
                    WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                };
                using (var backend = new Process { StartInfo = start }) {
                    try {
                        backend.Start();
                        backend.BeginErrorReadLine();
                        string ready = backend.StandardOutput.ReadLine();
                        if (ready == null || !ready.StartsWith("ScoutPad ready:")) throw new IOException("Le serveur ne demarre pas. Le port 18114 est peut-etre deja utilise.");
                        if (Array.IndexOf(args, "--smoke-test") >= 0) { StopBackend(backend); return; }
                        using (var tray = new NotifyIcon()) {
                            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                            tray.Text = "ScoutPad";
                            var menu = new ContextMenuStrip();
                            menu.Items.Add("Ouvrir ScoutPad", null, delegate { OpenBrowser(); });
                            menu.Items.Add("Arreter ScoutPad", null, delegate { Application.Exit(); });
                            tray.ContextMenuStrip = menu;
                            tray.DoubleClick += delegate { OpenBrowser(); };
                            tray.Visible = true;
                            var timer = new System.Windows.Forms.Timer { Interval = 1000 };
                            timer.Tick += delegate { if (backend.HasExited) Application.Exit(); };
                            timer.Start();
                            OpenBrowser();
                            Application.Run();
                            timer.Dispose();
                            tray.Visible = false;
                        }
                        StopBackend(backend);
                    } catch (Exception error) {
                        try { StopBackend(backend); } catch { }
                        if (Array.IndexOf(args, "--smoke-test") < 0) MessageBox.Show(error.Message, "ScoutPad", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        Environment.ExitCode = 1;
                    }
                }
            }
        }

        private static void OpenBrowser() {
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        }

        private static void StopBackend(Process backend) {
            if (backend.HasExited) return;
            backend.StandardInput.WriteLine("stop");
            backend.StandardInput.Flush();
            if (!backend.WaitForExit(12000)) backend.Kill();
        }
    }
}
