Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class WaveDevs {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
    struct WAVEOUTCAPS {
        public ushort wMid, wPid, verMaj, verMin;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)]
        public string szPname;
        public uint dwFormats, wChannels, wReserved1, dwSupport;
    }
    [DllImport("winmm.dll")] static extern int waveOutGetNumDevs();
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    static extern int waveOutGetDevCaps(uint id, ref WAVEOUTCAPS c, uint sz);
    public static string[] Names() {
        int n = waveOutGetNumDevs();
        var r = new string[n];
        for (int i=0;i<n;i++){var c=new WAVEOUTCAPS();waveOutGetDevCaps((uint)i,ref c,(uint)Marshal.SizeOf(c));r[i]=c.szPname;}
        return r;
    }
}
'@
Write-Host "WaveOut playback devices:"
$devs = [WaveDevs]::Names()
for ($i=0; $i -lt $devs.Length; $i++) { Write-Host "  $i : $($devs[$i])" }
